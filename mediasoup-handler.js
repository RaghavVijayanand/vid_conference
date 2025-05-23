const mediasoup = require('mediasoup');

// Global mediasoup worker and router instances.
// A worker represents a mediasoup process, and a router handles WebRTC traffic for a set of peers.
let worker;
let router;

// Defines the media codecs that the mediasoup router will support.
// These codecs must be compatible with what the connecting clients (browsers) support.
const mediaCodecs = [
  {
    kind: 'audio', // Specifies that this codec is for audio
    mimeType: 'audio/opus', // Standard Opus codec for WebRTC audio
    clockRate: 48000, // Standard clock rate for Opus
    channels: 2 // Stereo audio
  },
  {
    kind: 'video', // Specifies that this codec is for video
    mimeType: 'video/VP8', // Standard VP8 codec for WebRTC video
    clockRate: 90000, // Standard clock rate for VP8
    parameters: {} // Codec-specific parameters (none needed for VP8 here)
  }
];

/**
 * Initializes the mediasoup worker and router.
 * The worker is a single process that can host multiple routers.
 * The router is responsible for routing media streams among peers.
 */
async function startMediasoup() {
  try {
    // Create a mediasoup worker.
    // logLevel can be 'debug', 'warn', 'error', or 'none'. 'warn' is a good default.
    worker = await mediasoup.createWorker({
      logLevel: 'warn' 
    });

    // Listen for the 'died' event, which indicates the worker process has crashed.
    // If it dies, log the error and exit the application process.
    worker.on('died', () => {
      console.error('mediasoup worker has died, exiting in 2 seconds... [pid:%d]', process.pid);
      setTimeout(() => process.exit(1), 2000);
    });

    // Create a mediasoup router with the defined media codecs.
    router = await worker.createRouter({ mediaCodecs });
    console.log('Mediasoup worker and router created successfully');
  } catch (err) {
    console.error('Error starting mediasoup:', err);
    throw err; // Propagate error to be handled by server.js, which will exit.
  }
}

/**
 * Gets the global mediasoup router instance.
 * @returns {mediasoup.Router} The mediasoup router.
 */
function getRouter() {
  return router;
}

/**
 * Creates a WebRTC transport on the server for a specific client.
 * This transport will be used to send or receive media.
 * @param {string} socketId - The socket ID of the client.
 * @param {string} type - The type of transport ('send' or 'recv').
 * @param {Array<mediasoup.WebRtcTransport>} peerTransports - The array holding the peer's transports (managed by socket-handler).
 *                                                          This function will add the new transport to this array.
 * @returns {Promise<Object>} An object containing transport parameters needed by the client.
 * @throws {Error} If transport creation fails.
 */
async function createWebRtcTransport(socketId, type, peerTransports) {
  try {
    // Create a WebRTC transport using the router.
    // listenIps defines the IP and announced IP for the server. ANNOUNCED_IP should be the public IP in production.
    // enableUdp, enableTcp, preferUdp are standard WebRTC settings.
    // appData allows storing custom data with the transport, here used for tracking socketId and type.
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: { socketId, type } 
    });

    // Listen for 'dtlsstatechange'. If it becomes 'closed', the transport is no longer usable.
    // Close the transport server-side and log it.
    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        console.log(`Transport closed for ${type} for socket ${socketId}`);
        // Note: transport.close() is automatically called by mediasoup when the associated Router or Worker is closed.
        // Explicitly calling it here ensures cleanup if closed for other reasons.
        // The 'close' event on the transport will also be emitted, which can be used for further cleanup if needed.
      }
    });

    // For debugging: listen for 'routerclose' event if needed
    // transport.on('routerclose', () => {
    //   console.log(`Transport router closed for ${type} for socket ${socketId}`);
    // });

    // Add the newly created transport to the peer's list of transports (managed in socket-handler).
    // This allows socket-handler to find and manage it later.
    peerTransports.push(transport);

    // Return parameters needed by the client to initialize its side of the transport.
    return {
      id: transport.id, // ID of the server-side transport
      iceParameters: transport.iceParameters, // ICE parameters
      iceCandidates: transport.iceCandidates, // ICE candidates
      dtlsParameters: transport.dtlsParameters, // DTLS parameters for securing the connection
    };
  } catch (err) {
    console.error(`Error creating ${type} WebRTC transport for socket ${socketId}:`, err);
    throw err; // Propagate to be caught by socket-handler and sent to client.
  }
}

/**
 * Connects a server-side transport using DTLS parameters from the client.
 * This is part of the WebRTC handshake.
 * @param {mediasoup.WebRtcTransport} transport - The server-side transport instance.
 * @param {Object} dtlsParameters - DTLS parameters provided by the client.
 * @throws {Error} If connection fails.
 */
async function connectTransport(transport, dtlsParameters) {
  try {
    await transport.connect({ dtlsParameters });
  } catch (err) {
    console.error(`Error connecting transport ${transport.id}:`, err);
    throw err;
  }
}

/**
 * Creates a media producer on the server-side transport.
 * A producer represents a media track (audio or video) being sent by the client.
 * @param {mediasoup.WebRtcTransport} transport - The server-side send transport.
 * @param {string} kind - The kind of media ('audio' or 'video').
 * @param {Object} rtpParameters - RTP parameters defining how the media is to be sent.
 * @param {Array<mediasoup.Producer>} peerProducers - The array holding the peer's producers (managed by socket-handler).
 *                                                   This function will add the new producer to this array.
 * @returns {Promise<mediasoup.Producer>} The created producer instance.
 * @throws {Error} If producer creation fails.
 */
async function createProducer(transport, kind, rtpParameters, peerProducers) {
  try {
    // Create a producer on the transport.
    // appData can store custom data; here, we merge client-provided appData from rtpParameters
    // with the server-known socketId from the transport's appData.
    // Note: The client's rtpParameters.appData might be empty or contain specific info.
    // The producer's appData on the server will combine these.
    const producer = await transport.produce({ 
        kind, 
        rtpParameters, 
        appData: { ...(rtpParameters.appData || {}), socketId: transport.appData.socketId } 
    });
    
    // Add the producer to the peer's list.
    peerProducers.push(producer);

    // For debugging: listen for 'transportclose' event on producer if needed
    // producer.on('transportclose', () => {
    //   console.log(`Producer's transport closed ${producer.id}`);
    //   producer.close(); // Close the producer if its transport closes.
    // });

    return producer;
  } catch (err) {
    console.error(`Error creating producer for transport ${transport.id}:`, err);
    throw err;
  }
}

/**
 * Creates a media consumer on the server-side transport.
 * A consumer represents a media track being received by the client from another peer.
 * @param {string} producerId - The ID of the producer to consume.
 * @param {Object} rtpCapabilities - RTP capabilities of the consuming client.
 * @param {mediasoup.WebRtcTransport} transport - The server-side receive transport.
 * @param {Array<mediasoup.Consumer>} peerConsumers - The array holding the peer's consumers (managed by socket-handler).
 *                                                   This function will add the new consumer to this array.
 * @returns {Promise<mediasoup.Consumer>} The created consumer instance.
 * @throws {Error} If consumer creation fails or if the client cannot consume the producer.
 */
async function createConsumer(producerId, rtpCapabilities, transport, peerConsumers) {
  // Check if the router can consume the requested producer with the client's capabilities.
  if (!router.canConsume({ producerId, rtpCapabilities })) {
    const msg = `Client (socket: ${transport.appData.socketId}) cannot consume producer ${producerId}`;
    console.error('createConsumer:', msg);
    throw new Error(msg);
  }
  try {
    // Create a consumer on the transport.
    // paused: false ensures media flows immediately after consumption.
    // appData stores relevant IDs for tracking.
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false, 
      appData: { socketId: transport.appData.socketId, producerId }
    });

    // Add the consumer to the peer's list.
    peerConsumers.push(consumer);

    // For debugging: listen for events on consumer if needed
    // consumer.on('transportclose', () => { /* Consumer's transport closed */ });
    // consumer.on('producerclose', () => { /* Producer that this consumer is consuming closed */ });
    
    // It's good practice to resume the consumer server-side if it's not created paused.
    // However, mediasoup-client typically handles resuming on the client-side.
    // If created with paused: true, client would need to send a 'resume' signal.
    // If created with paused: false (default or explicit), it should start.
    // await consumer.resume(); // This is often not needed if consumer is not created paused.

    return consumer;
  } catch (err) {
    console.error(`Error creating consumer for producer ${producerId} on transport ${transport.id}:`, err);
    throw err;
  }
}

// Note: A specific `cleanupPeer` function was mentioned in the task description's comments section,
// but it's not explicitly defined as an export or used directly by socket-handler in the current structure.
// Cleanup is handled within socket-handler.js on 'disconnect' by iterating and closing transports,
// which in turn should close associated producers and consumers via their event listeners (e.g., 'transportclose').
// If a direct cleanup function were needed here, it would look something like:
/*
function cleanupPeer(peer) {
  console.log(`Cleaning up resources for peer ${peer.socket.id}`);
  peer.transports.forEach(t => t.close());
  // Producers and Consumers are generally closed when their transport closes.
  // If explicit closure is needed:
  // peer.producers.forEach(p => p.close());
  // peer.consumers.forEach(c => c.close());
}
*/


module.exports = {
  startMediasoup,
  getRouter,
  createWebRtcTransport,
  connectTransport,
  createProducer,
  createConsumer,
  mediaCodecs // Exporting for potential use elsewhere, though router.rtpCapabilities is preferred for client.
};
