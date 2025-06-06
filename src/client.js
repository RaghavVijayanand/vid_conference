import * as mediasoupClient from 'mediasoup-client';

// Connect to the backend Socket.IO server with fallback transports
const socket = io('https://localhost:3000', { 
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    timeout: 5000
});

// Add connection debugging
socket.on('connect', () => {
    console.log('Connected to server with socket ID:', socket.id);
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
});

const joinBtn = document.getElementById('joinBtn');
const videosDiv = document.getElementById('videos');
const spinner = document.getElementById('spinner');
const participantsDiv = document.getElementById('participants');
const toastDiv = document.getElementById('toast');

let localStream;
let device;
let sendTransport;
let recvTransport;
let producers = [];
let participants = {};

// Polyfill for navigator.mediaDevices if it is not defined
if (navigator.mediaDevices === undefined) {
    navigator.mediaDevices = {};
}
if (navigator.mediaDevices.getUserMedia === undefined) {
    navigator.mediaDevices.getUserMedia = function(constraints) {
        const getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
        if (!getUserMedia) {
            return Promise.reject(new Error('getUserMedia is not implemented in this browser'));
        }
        return new Promise((resolve, reject) => {
            getUserMedia.call(navigator, constraints, resolve, reject);
        });
    };
}

function showToast(message, isError = false) {
    toastDiv.textContent = message;
    toastDiv.className = isError ? 'error' : '';
    toastDiv.style.display = 'block';
    setTimeout(() => { toastDiv.style.display = 'none'; }, 3000);
}

function updateParticipants() {
    participantsDiv.innerHTML = '';
    Object.entries(participants).forEach(([id, info]) => {
        const p = document.createElement('div');
        p.className = 'participant' + (info.isLocal ? ' you' : '');
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = info.isLocal ? 'You' : (id.slice(0, 2).toUpperCase());
        const name = document.createElement('span');
        name.textContent = info.isLocal ? 'You' : id;
        p.appendChild(avatar);
        p.appendChild(name);
        participantsDiv.appendChild(p);
    });
}

function addVideo(stream, label, isLocal = false) {
    const card = document.createElement('div');
    card.className = 'video-card';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.setAttribute('data-label', label);
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = label;
    card.appendChild(video);
    card.appendChild(labelDiv);
    videosDiv.appendChild(card);
    // Add to participants
    if (isLocal) {
        participants['you'] = { isLocal: true };
    } else {
        participants[label] = { isLocal: false };
    }
    updateParticipants();
}

joinBtn.onclick = async () => {
    joinBtn.disabled = true;
    spinner.style.display = 'flex';
    try {
        if (!navigator.mediaDevices) {
            throw new Error('navigator.mediaDevices is not defined');
        }
        if (!navigator.mediaDevices.getUserMedia) {
            throw new Error('navigator.mediaDevices.getUserMedia is not defined');
        }
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        addVideo(localStream, 'You', true);
        showToast('Joined conference!');
        // --- mediasoup signaling ---
        // 1. Get RTP Capabilities
        const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        // 2. Create send transport
        const transportInfo = await new Promise(res => socket.emit('createWebRtcTransport', res));
        sendTransport = device.createSendTransport(transportInfo);
        sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, ({ connected, error }) => {
                if (connected) callback();
                else errback(error);
            });
        });
        // 2b. Create receive transport
        const recvTransportInfo = await new Promise(res => socket.emit('createRecvTransport', res));
        recvTransport = device.createRecvTransport(recvTransportInfo);
        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, ({ connected, error }) => {
                if (connected) callback();
                else errback(error);
            });
        });
        sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, ({ id, error }) => {
                if (id) callback({ id });
                else errback(error);
            });
        });
        // 3. Produce local tracks
        for (const track of localStream.getTracks()) {
            const producer = await sendTransport.produce({ track });
            producers.push(producer);
        }        // NEW: Consume existing producers
        console.log('Checking for existing producers...');
        const existingProducers = await new Promise(res => socket.emit('getProducers', res));
        console.log('Existing producers:', existingProducers);
        for (const { socketId, producerId, kind } of existingProducers) {
            if (!device) continue;
            console.log('Consuming existing producer:', { socketId, producerId, kind });
            const rtpCapabilities = device.rtpCapabilities;
            const consumerInfo = await new Promise(res => socket.emit('consume', { producerId, rtpCapabilities }, res));
            if (consumerInfo.error) {
                console.error('Failed to consume existing producer:', consumerInfo.error);
                continue;
            }
            console.log('Consumer info for existing producer:', consumerInfo);
            // Use recvTransport for consuming
            const consumer = await recvTransport.consume({
                id: consumerInfo.id,
                producerId: consumerInfo.producerId,
                kind: consumerInfo.kind,
                rtpParameters: consumerInfo.rtpParameters,
            });
            await consumer.resume();
            console.log('Existing producer consumer created:', consumer.id);
            const remoteStream = new MediaStream([consumer.track]);
            addVideo(remoteStream, socketId);
        }
        spinner.style.display = 'none';
    } catch (err) {
        showToast('Could not join: ' + err.message, true);
        joinBtn.disabled = false;
        spinner.style.display = 'none';
    }
};

// Listen for new producers from other peers
socket.on('newProducer', async ({ socketId, producerId, kind }) => {
    console.log('New producer detected:', { socketId, producerId, kind });
    if (!device) {
        console.log('Device not ready yet');
        return;
    }
    const rtpCapabilities = device.rtpCapabilities;
    // Ask server to create a consumer
    console.log('Requesting consumer for producer:', producerId);
    const consumerInfo = await new Promise(res => socket.emit('consume', { producerId, rtpCapabilities }, res));
    if (consumerInfo.error) {
        console.error('Failed to create consumer:', consumerInfo.error);
        return;
    }
    console.log('Consumer info received:', consumerInfo);
    // Use recvTransport for consuming
    const consumer = await recvTransport.consume({
        id: consumerInfo.id,
        producerId: consumerInfo.producerId,
        kind: consumerInfo.kind,
        rtpParameters: consumerInfo.rtpParameters,
    });
    await consumer.resume();
    console.log('Consumer created and resumed:', consumer.id);
    const remoteStream = new MediaStream([consumer.track]);
    addVideo(remoteStream, socketId);
    showToast('A new participant joined!');
});
