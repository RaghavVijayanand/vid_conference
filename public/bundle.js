(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
const socket = io();

const joinBtn = document.getElementById('joinBtn');
const videosDiv = document.getElementById('videos');

let localStream;
let device;
let sendTransport;
let producers = [];

// mediasoup-client is now loaded via <script> and available as window.mediasoupClient

joinBtn.onclick = async () => {
  joinBtn.disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addVideo(localStream, 'local');
    // --- mediasoup signaling ---
    const mediasoupClient = window.mediasoupClient;
    // 1. Get RTP Capabilities
    const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    // 2. Create send transport
    const transportInfo = await new Promise(res => socket.emit('createWebRtcTransport', res));
    sendTransport = device.createSendTransport(transportInfo);
    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, ({ connected, error }) => {
        if (connected) callback(); else errback(error);
      });
    });
    sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, ({ id, error }) => {
        if (id) callback({ id }); else errback(error);
      });
    });
    // 3. Produce local tracks
    for (const track of localStream.getTracks()) {
      const producer = await sendTransport.produce({ track });
      producers.push(producer);
    }
    // TODO: consume remote tracks
  } catch (err) {
    alert('Could not join: ' + err.message);
    joinBtn.disabled = false;
  }
};

function addVideo(stream, label) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.setAttribute('data-label', label);
  videosDiv.appendChild(video);
}

// Listen for new producers from other peers
socket.on('newProducer', async ({ socketId, producerId, kind }) => {
  if (!device) return;
  const rtpCapabilities = device.rtpCapabilities;
  // Ask server to create a consumer
  const consumerInfo = await new Promise(res => socket.emit('consume', { producerId, rtpCapabilities }, res));
  if (consumerInfo.error) return;
  const recvTransport = sendTransport; // For demo, use same transport for consuming
  const consumer = await recvTransport.consume({
    id: consumerInfo.id,
    producerId: consumerInfo.producerId,
    kind: consumerInfo.kind,
    rtpParameters: consumerInfo.rtpParameters,
  });
  const remoteStream = new MediaStream([consumer.track]);
  addVideo(remoteStream, socketId);
}); 
},{}]},{},[1]);
