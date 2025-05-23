// Mock mediasoup-handler before any imports
const mockActualTransportObject = {
  id: 'mockTransportId',
  iceParameters: {},
  iceCandidates: [],
  dtlsParameters: {},
  appData: { type: 'send' }, // Default type, can be overridden in specific calls
  // Mock other methods if transport methods are called directly by socket-handler (e.g., transport.close())
  close: jest.fn(),
  // connect: jest.fn(), // connect is called on transport in mediasoup-handler, not socket-handler
  // produce: jest.fn(), // produce is called on transport in mediasoup-handler, not socket-handler
};

const mockActualProducerObject = {
  id: 'mockProducerId',
  kind: 'audio', // Default, can be overridden
  appData: {},    // Default, can be augmented
  // Mock other methods if producer methods are called by socket-handler
  close: jest.fn(),
};


jest.mock('../mediasoup-handler', () => {
  const originalMediasoupHandler = jest.requireActual('../mediasoup-handler');
  return {
    ...originalMediasoupHandler, // Import and retain original static values like mediaCodecs if any are used directly
    getRouter: jest.fn(() => ({
      rtpCapabilities: { codecs: [], headerExtensions: [] }
    })),
    createWebRtcTransport: jest.fn(async (socketId, type, peerTransportsArray) => {
      // Simulate the actual behavior of mediasoup-handler pushing the transport
      const newTransport = { ...mockActualTransportObject, id: `mockTransport_${type}_${Date.now()}`, appData: { socketId, type } };
      peerTransportsArray.push(newTransport); // This is key: modify the passed array
      return { // Return the transport *info* as the actual function does
        id: newTransport.id,
        iceParameters: newTransport.iceParameters,
        iceCandidates: newTransport.iceCandidates,
        dtlsParameters: newTransport.dtlsParameters,
      };
    }),
    connectTransport: jest.fn(() => Promise.resolve()),
    createProducer: jest.fn(async (transport, kind, rtpParameters, peerProducersArray) => {
      const newProducer = { ...mockActualProducerObject, kind, appData: { ...rtpParameters.appData, socketId: transport.appData.socketId } };
      peerProducersArray.push(newProducer); // Simulate pushing to the passed array
      return newProducer; // Return the full producer object as the actual function does
    }),
    createConsumer: jest.fn(() => Promise.resolve({ id: 'mockConsumerId', kind: 'audio', rtpParameters: {} })),
    cleanupPeer: jest.fn(),
  };
});

// Mock the main 'io' object and individual socket objects
const mockIo = {
  emit: jest.fn(),
  on: jest.fn((event, handler) => {
    // Store the handler to be called later if needed, especially for 'connection'
    if (!mockIo.handlers) mockIo.handlers = {};
    mockIo.handlers[event] = handler;
  }),
  // Utility to get a stored handler
  getHandler: (event) => mockIo.handlers[event],
};

const mockSocket = {
  id: 'testSocketId',
  on: jest.fn((event, handler) => {
     // Store handlers for individual socket events
    if (!mockSocket.handlers) mockSocket.handlers = {};
    mockSocket.handlers[event] = handler;
  }),
  emit: jest.fn(), // For direct messages from socket to client
  broadcast: { // For messages broadcasted by this socket
    emit: jest.fn()
  },
  join: jest.fn(), // For room joining
  leave: jest.fn(), // For room leaving
  // Utility to get a stored handler for socket events
  getHandler: (event) => mockSocket.handlers[event],
  // Utility to simulate an event emission on this socket
  simulate: (event, ...args) => {
    const handler = mockSocket.getHandler(event);
    if (handler) {
      // If the handler expects a callback, we need to provide one.
      // This simplistic simulate won't handle callbacks well unless the test calls it.
      // For events like 'getRtpCapabilities', the last arg is the callback.
      if (args.length > 0 && typeof args[args.length -1] === 'function') {
        handler(...args);
      } else {
        // For events without a callback, or where callback is not the last arg
        handler(...args, () => {}); // Provide a dummy callback
      }
    } else {
      console.warn(`No handler found for event ${event} on mockSocket`);
    }
  }
};


// Now import socket-handler (it will get the mocked mediasoup-handler)
// socket-handler.js exports { initSocketHandler }
const { initSocketHandler } = require('../socket-handler'); 

describe('Socket Handler Logic', () => {

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
    // Clear handlers stored on mocks
    mockIo.handlers = {};
    mockSocket.handlers = {};


    // Initialize socket-handler;
    initSocketHandler(mockIo); // Pass the mocked io object

    // Simulate a new connection to allow testing connection-related logic
    // The 'connection' handler should have been stored on mockIo by initSocketHandler
    const connectionCallback = mockIo.getHandler('connection');
    if (connectionCallback) {
      connectionCallback(mockSocket); // Simulate a client connecting
    } else {
      throw new Error("Connection handler not registered on mockIo by initSocketHandler");
    }
  });

  test('should register disconnect handler for a new connection', () => {
    expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('getRtpCapabilities', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('createWebRtcTransport', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('connectTransport', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('produce', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('consume', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('getProducers', expect.any(Function));
    // createRecvTransport is also an event
    expect(mockSocket.on).toHaveBeenCalledWith('createRecvTransport', expect.any(Function));
  });

  test('getRtpCapabilities should callback with routerRtpCapabilities from mediasoup-handler', (done) => {
    const rtpCapabilitiesHandler = mockSocket.getHandler('getRtpCapabilities');
    expect(rtpCapabilitiesHandler).toBeDefined();
    
    rtpCapabilitiesHandler((rtpCaps) => {
      expect(rtpCaps).toEqual({ codecs: [], headerExtensions: [] }); // Matches mock from mediasoup-handler
      const mediasoupHandler = require('../mediasoup-handler');
      expect(mediasoupHandler.getRouter).toHaveBeenCalled();
      done();
    });
  });
  
  test('should emit "participantLeft" on io when a client disconnects', () => {
    const disconnectHandler = mockSocket.getHandler('disconnect');
    expect(disconnectHandler).toBeDefined();

    disconnectHandler(); // Simulate disconnect
    
    expect(mockIo.emit).toHaveBeenCalledWith('participantLeft', { socketId: 'testSocketId' });
  });

  test('createWebRtcTransport should call mediasoupHandler.createWebRtcTransport and callback', async () => {
    const createWebRtcTransportCallback = jest.fn();
    const createWebRtcTransportHandler = mockSocket.getHandler('createWebRtcTransport');
    expect(createWebRtcTransportHandler).toBeDefined();

    // Simulate client emitting 'createWebRtcTransport' with data and a callback
    await createWebRtcTransportHandler({ type: 'send' }, createWebRtcTransportCallback);
    
    const mediasoupHandler = require('../mediasoup-handler');
    expect(mediasoupHandler.createWebRtcTransport).toHaveBeenCalledWith(
      'testSocketId', 
      'send',         
      expect.arrayContaining([expect.objectContaining({ appData: { socketId: 'testSocketId', type: 'send' } })])
    );
    // Check callback contains an ID (the exact ID is dynamic due to Date.now() in mock)
    expect(createWebRtcTransportCallback).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringContaining('mockTransport_send_'),
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {}
    }));
  });
  
  test('createRecvTransport should call mediasoupHandler.createWebRtcTransport with type "recv" and callback', async () => {
    const createRecvTransportCallback = jest.fn();
    const createRecvTransportHandler = mockSocket.getHandler('createRecvTransport');
    expect(createRecvTransportHandler).toBeDefined();

    await createRecvTransportHandler(createRecvTransportCallback);
    
    const mediasoupHandler = require('../mediasoup-handler');
    expect(mediasoupHandler.createWebRtcTransport).toHaveBeenCalledWith(
      'testSocketId',
      'recv',
      expect.arrayContaining([expect.objectContaining({ appData: { socketId: 'testSocketId', type: 'recv' } })])
    );
    expect(createRecvTransportCallback).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringContaining('mockTransport_recv_'),
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {}
    }));
  });

  test('connectTransport should call mediasoupHandler.connectTransport', async () => {
    const connectTransportCallback = jest.fn();
    const connectTransportHandler = mockSocket.getHandler('connectTransport');
    expect(connectTransportHandler).toBeDefined();

    // First, ensure a transport is "created" by calling the handler that does so.
    const createTransportCb = jest.fn();
    const createWebRtcTransportHandler = mockSocket.getHandler('createWebRtcTransport');
    await createWebRtcTransportHandler({ type: 'send' }, createTransportCb);
    
    // Get the ID of the transport that was "created" and "pushed" by the mock
    const createdTransportInfo = createTransportCb.mock.calls[0][0];
    expect(createdTransportInfo).toBeDefined();
    expect(createdTransportInfo.id).toBeDefined();

    await connectTransportHandler({ transportId: createdTransportInfo.id, dtlsParameters: {} }, connectTransportCallback);
    
    const mediasoupHandler = require('../mediasoup-handler');
    expect(mediasoupHandler.connectTransport).toHaveBeenCalledWith(
      expect.objectContaining({ id: createdTransportInfo.id }), 
      {} 
    );
    expect(connectTransportCallback).toHaveBeenCalledWith({ connected: true });
  });

  test('produce should call mediasoupHandler.createProducer and broadcast newProducer', async () => {
    const produceCallback = jest.fn();
    const produceHandler = mockSocket.getHandler('produce');
    expect(produceHandler).toBeDefined();

    // Simulate transport creation first
    const createTransportCb = jest.fn();
    const createWebRtcTransportHandler = mockSocket.getHandler('createWebRtcTransport');
    // Ensure it's a 'send' transport for producing
    await createWebRtcTransportHandler({ type: 'send' }, createTransportCb);
    const createdTransportInfo = createTransportCb.mock.calls[0][0];
    expect(createdTransportInfo).toBeDefined();


    const produceData = {
      transportId: createdTransportInfo.id,
      kind: 'audio',
      rtpParameters: { mid: '0' }, // Example rtpParameters
      appData: { source: 'mic' }   // Example appData from client
    };
    await produceHandler(produceData, produceCallback);

    const mediasoupHandler = require('../mediasoup-handler');
    // Verify createProducer was called with the correct transport object and other params
    expect(mediasoupHandler.createProducer).toHaveBeenCalledWith(
      expect.objectContaining({ id: createdTransportInfo.id, appData: { socketId: 'testSocketId', type: 'send' } }),
      produceData.kind,
      produceData.rtpParameters,
      expect.arrayContaining([expect.objectContaining({ kind: 'audio' })]) // peer.producers should now contain the new producer
    );
    // The mock for createProducer returns the full producer object
    const mockProducerReturned = mediasoupHandler.createProducer.mock.results[0].value; // This should be the newProducer object
    
    // Check what produceCallback was called with
    // console.log('produceCallback called with:', JSON.stringify(produceCallback.mock.calls[0][0]));
    // console.log('mockProducerReturned is:', JSON.stringify(mockProducerReturned));

    expect(produceCallback).toHaveBeenCalledWith({ id: 'mockProducerId' }); 

    // Based on current mock of mediasoupHandler.createProducer,
    // which uses rtpParameters.appData (which is undefined in test's produceData.rtpParameters)
    // and adds socketId.
    const expectedProducerAppDataInBroadcast = { socketId: 'testSocketId' };

    expect(mockSocket.broadcast.emit).toHaveBeenCalledWith('newProducer', {
      socketId: 'testSocketId',
      producerId: 'mockProducerId', 
      kind: produceData.kind, 
      appData: expectedProducerAppDataInBroadcast
    });
  });
  // More tests can be added for 'consume' and 'getProducers'
  // For 'consume', it's similar to 'produce': ensure transport exists, then call mediasoupHandler.createConsumer
  // For 'getProducers', it iterates over the internal `peers` map. Testing this would require
  // being able to populate `peers` with other mock sockets and their producers, which is more involved.
  // A simpler test for 'getProducers' could check that it calls back with an empty array if no other peers/producers exist.

  test('getProducers should callback with an empty list if no other producers', (done) => {
    const getProducersHandler = mockSocket.getHandler('getProducers');
    expect(getProducersHandler).toBeDefined();

    getProducersHandler((producerList) => {
      expect(producerList).toEqual([]);
      done();
    });
  });

});
