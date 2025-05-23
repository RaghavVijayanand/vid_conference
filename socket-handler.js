// Import the mediasoup-handler module which encapsulates mediasoup-specific logic.
const mediasoupHandler = require('./mediasoup-handler');

// The `peers` Map stores information about connected clients (peers).
// Key: socket.id of the client.
// Value: An object containing { transports: [], producers: [], consumers: [], socket: Socket }.
//   - transports: Array of mediasoup WebRtcTransport objects for this peer.
//   - producers: Array of mediasoup Producer objects (media sent by this peer).
//   - consumers: Array of mediasoup Consumer objects (media received by this peer).
//   - socket: The actual Socket.IO socket object for direct communication if needed.
const peers = new Map();

/**
 * Initializes the Socket.IO event handlers for signaling.
 * This function is called once when the server starts.
 * @param {SocketIO.Server} io - The Socket.IO server instance.
 */
function initSocketHandler(io) {
  // Listen for new client connections.
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Store the new peer's information.
    peers.set(socket.id, { 
      transports: [], 
      producers: [], 
      consumers: [], 
      socket // Storing the socket object itself for potential direct messaging.
    });

    // Handle client disconnection.
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      // Notify all other connected clients that this participant has left.
      // This allows clients to update their UI, remove video elements, etc.
      io.emit('participantLeft', { socketId: socket.id });

      const peer = peers.get(socket.id);
      if (peer) {
        // Close all mediasoup transports associated with this peer.
        // Closing transports will also trigger cleanup of associated producers and consumers
        // if their 'transportclose' events are handled in mediasoup-handler.js.
        peer.transports.forEach(t => {
          try {
            t.close(); 
          } catch (e) {
            console.error(`Error closing transport ${t.id} for peer ${socket.id}:`, e);
          }
        });
        // Note: Producers and Consumers are often managed by the lifecycle of their transport.
        // If mediasoup-handler ensures producers/consumers are closed when their transport is closed,
        // explicit closing here might be redundant. However, direct closure can be added if necessary.
        // peer.producers.forEach(p => p.close());
        // peer.consumers.forEach(c => c.close());
      }
      // Remove the peer from the map.
      peers.delete(socket.id);
      console.log(`Peer ${socket.id} resources cleaned up and removed.`);
    });

    // Typical WebRTC/mediasoup signaling flow:
    // 1. Client asks for Router RTP Capabilities.
    // 2. Client creates WebRTC transports (one for sending, one for receiving).
    //    - This involves server creating transport and sending its details to client.
    // 3. Client connects its local transport to the server-side transport using DTLS parameters.
    // 4. Client starts producing media (e.g., webcam, microphone).
    // 5. Client requests to consume media from other peers.

    // Handler for 'getRtpCapabilities': Client requests the mediasoup router's RTP capabilities.
    // This is needed for the client to initialize its mediasoup Device.
    socket.on('getRtpCapabilities', (callback) => {
      try {
        const router = mediasoupHandler.getRouter();
        if (!router) {
          console.error('getRtpCapabilities: Router not initialized');
          return callback({ error: 'Router not initialized' });
        }
        // Send the router's RTP capabilities back to the client.
        callback(router.rtpCapabilities);
      } catch (err) {
        console.error('Error in getRtpCapabilities:', err);
        callback({ error: 'Failed to get RTP capabilities: ' + err.message });
      }
    });

    // Handler for 'createWebRtcTransport': Client requests to create a WebRTC transport.
    // The client can specify the type of transport ('send' or 'recv') in the `data` payload.
    // This event was intended to replace 'createSendTransport' and 'createRecvTransport'
    // but 'createRecvTransport' is kept for client compatibility if it uses distinct events.
    socket.on('createWebRtcTransport', async (data, callback) => {
      try {
        const peer = peers.get(socket.id);
        if (!peer) {
          console.error(`createWebRtcTransport: Peer not found for socket ${socket.id}`);
          return callback({ error: 'Peer not found' });
        }
        // Determine transport type from client data, defaulting to 'send'.
        const transportType = data && data.type === 'recv' ? 'recv' : 'send';

        // Call mediasoup-handler to create the transport.
        // `peer.transports` array is passed so mediasoup-handler can add the new transport to it.
        const transportInfo = await mediasoupHandler.createWebRtcTransport(socket.id, transportType, peer.transports);
        callback(transportInfo); // Send transport parameters back to the client.
      } catch (err) {
        console.error(`Error creating WebRTC transport for socket ${socket.id}:`, err);
        callback({ error: `Failed to create WebRTC transport: ${err.message}` });
      }
    });
    
    // Handler for 'createRecvTransport': Client specifically requests a receive transport.
    // This is often used for consuming media from other peers.
    socket.on('createRecvTransport', async (callback) => {
        try {
            const peer = peers.get(socket.id);
            if (!peer) {
                console.error(`createRecvTransport: Peer not found for socket ${socket.id}`);
                return callback({ error: 'Peer not found' });
            }
            // Call mediasoup-handler to create a 'recv' transport.
            const transportInfo = await mediasoupHandler.createWebRtcTransport(socket.id, 'recv', peer.transports);
            callback(transportInfo);
        } catch (err) {
            console.error(`Error creating Recv WebRTC transport for socket ${socket.id}:`, err);
            callback({ error: `Failed to create Recv WebRTC transport: ${err.message}` });
        }
    });

    // Handler for 'connectTransport': Client provides DTLS parameters to connect its transport.
    // This is part of the DTLS handshake to secure the WebRTC connection.
    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        const peer = peers.get(socket.id);
        if (!peer) throw new Error('Peer not found');
        // Find the previously created server-side transport by its ID.
        const transport = peer.transports.find(t => t.id === transportId);
        if (!transport) throw new Error(`Transport with ID ${transportId} not found`);
        
        // Call mediasoup-handler to connect the transport.
        await mediasoupHandler.connectTransport(transport, dtlsParameters);
        callback({ connected: true });
      } catch (err) {
        console.error(`Error connecting transport ${transportId} for socket ${socket.id}:`, err);
        callback({ error: `Failed to connect transport: ${err.message}` });
      }
    });

    // Handler for 'produce': Client intends to send media (audio or video).
    // It provides details like kind of media and RTP parameters.
    socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const peer = peers.get(socket.id);
        if (!peer) throw new Error('Peer not found');
        // Find the send transport.
        const transport = peer.transports.find(t => t.id === transportId);
        if (!transport) throw new Error(`Send transport with ID ${transportId} not found`);
        
        // Ensure this transport is designated for sending.
        if (transport.appData.type !== 'send') {
            throw new Error(`Transport ${transportId} is not a 'send' transport.`);
        }

        // Call mediasoup-handler to create a producer.
        // `peer.producers` array is passed for mediasoup-handler to add the new producer.
        // The `appData` from the client event is intended for the producer object on the server.
        // Note: mediasoup-handler's createProducer internally incorporates this `appData`
        // with `rtpParameters.appData` if `transport.produce` is structured to use it.
        // Current mediasoup-handler's createProducer uses rtpParameters.appData and adds socketId.
        // For client's top-level `appData` to be used, it should be passed explicitly or merged into rtpParameters.
        const producer = await mediasoupHandler.createProducer(transport, kind, rtpParameters, peer.producers);
        
        callback({ id: producer.id }); // Send the new producer's ID back to the client.
        
        // Inform all other connected clients that a new producer is available.
        // This allows them to initiate consumption of this new media stream.
        socket.broadcast.emit('newProducer', {
          socketId: socket.id, // ID of the peer that started producing
          producerId: producer.id,
          kind: producer.kind,
          appData: producer.appData // Send the producer's appData (which might include client's original appData)
        });
      } catch (err) {
        console.error(`Error producing media for transport ${transportId} (socket ${socket.id}):`, err);
        callback({ error: `Failed to produce media: ${err.message}` });
      }
    });

    // Handler for 'consume': Client requests to receive media from a specific producer.
    socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
      try {
        const peer = peers.get(socket.id);
        if (!peer) throw new Error('Peer not found');
        
        let transport;
        // If client specifies a transportId, use that 'recv' transport.
        if (transportId) {
            transport = peer.transports.find(t => t.id === transportId && t.appData.type === 'recv');
            if (!transport) {
                 throw new Error(`Receiving transport ${transportId} not found or not of type 'recv'.`);
            }
        } else {
            // Otherwise, find any available 'recv' transport for this peer.
            transport = peer.transports.find(t => t.appData.type === 'recv');
            if (!transport) {
                // If no 'recv' transport exists, client might need to create one first.
                throw new Error('No receiving transport found. Please create one.');
            }
        }

        // Call mediasoup-handler to create a consumer.
        // `peer.consumers` array is passed for mediasoup-handler to add the new consumer.
        const consumerInfo = await mediasoupHandler.createConsumer(producerId, rtpCapabilities, transport, peer.consumers);
        // Send consumer parameters back to the client.
        callback({
          id: consumerInfo.id,
          producerId: consumerInfo.producerId,
          kind: consumerInfo.kind,
          rtpParameters: consumerInfo.rtpParameters,
          appData: consumerInfo.appData
        });
      } catch (err) {
        console.error(`Error consuming producer ${producerId} for socket ${socket.id}:`, err);
        callback({ error: `Failed to consume producer: ${err.message}` });
      }
    });

    // Handler for 'getProducers': Client requests a list of all available producers from other peers.
    // This is typically called when a client joins to start consuming existing media streams.
    socket.on('getProducers', (callback) => {
      try {
        const producerList = [];
        // Iterate over all peers.
        for (const [id, peer] of peers.entries()) {
          // Exclude the requesting peer's own producers.
          if (id !== socket.id) {
            // Add details of each producer from other peers to the list.
            for (const producer of peer.producers) {
              producerList.push({
                socketId: id, // ID of the peer owning the producer
                producerId: producer.id,
                kind: producer.kind,
                appData: producer.appData
              });
            }
          }
        }
        callback(producerList); // Send the list back to the client.
      } catch (err) {
        console.error('Error in getProducers:', err);
        callback({ error: 'Failed to get producers: ' + err.message });
      }
    });
  });
}

module.exports = {
  initSocketHandler,
  // Exposing `peers` map or functions to access it (like getPeer) can be done
  // if other modules need direct access, but it's generally better to encapsulate
  // peer management within this module and expose specific functions for interaction.
  // getPeer: (socketId) => peers.get(socketId), 
};
