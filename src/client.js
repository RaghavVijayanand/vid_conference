// Import the mediasoup-client library, which provides the client-side API for mediasoup.
import * as mediasoupClient from 'mediasoup-client';

// Establish a Socket.IO connection to the server.
// Replace 'https://192.168.2.7:3000' with your actual server URL in a real deployment.
// Using 'websocket' transport explicitly can sometimes help with connection reliability.
const socket = io('https://192.168.2.7:3000', { transports: ['websocket'] });

// DOM element references for UI interaction.
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const videosDiv = document.getElementById('videos'); // Container for video elements
const spinner = document.getElementById('spinner'); // Loading spinner
const participantsDiv = document.getElementById('participants'); // Container for participant list
const toastDiv = document.getElementById('toast'); // For showing notifications

// Global state variables for the client.
let localStream; // Holds the user's local audio/video stream.
let isAudioMuted = false; // Tracks the current audio mute state.
let device; // mediasoup-client Device instance. Represents this client's WebRTC capabilities.
let sendTransport; // mediasoup Transport for sending media.
let recvTransport; // mediasoup Transport for receiving media.
let producers = []; // Array to store local media producers (audio, video).
let participants = {}; // Object to store information about participants in the conference.

// Basic polyfill for navigator.mediaDevices.getUserMedia if it's not available.
// This is for older browser compatibility.
if (navigator.mediaDevices === undefined) {
    navigator.mediaDevices = {};
}
if (navigator.mediaDevices.getUserMedia === undefined) {
    navigator.mediaDevices.getUserMedia = function(constraints) {
        // Try to use vendor-prefixed versions if the standard one isn't available.
        const getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
        if (!getUserMedia) {
            return Promise.reject(new Error('getUserMedia is not implemented in this browser'));
        }
        // Promisify the old callback-based API.
        return new Promise((resolve, reject) => {
            getUserMedia.call(navigator, constraints, resolve, reject);
        });
    };
}

/**
 * Displays a toast message on the UI.
 * @param {string} message - The message to display.
 * @param {boolean} [isError=false] - True if the message is an error, for styling.
 */
function showToast(message, isError = false) {
    toastDiv.textContent = message;
    toastDiv.className = isError ? 'error' : ''; // Apply 'error' class for error messages
    toastDiv.style.display = 'block';
    // Hide the toast after 3 seconds.
    setTimeout(() => { toastDiv.style.display = 'none'; }, 3000);
}

/**
 * Updates the participant list displayed in the UI.
 * Iterates over the `participants` object and renders each participant.
 */
function updateParticipants() {
    participantsDiv.innerHTML = ''; // Clear existing list
    Object.entries(participants).forEach(([id, info]) => {
        const p = document.createElement('div');
        p.className = 'participant' + (info.isLocal ? ' you' : ''); // Special style for 'you'
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = info.isLocal ? 'You' : (id.slice(0, 2).toUpperCase()); // Display initials or 'You'
        const name = document.createElement('span');
        name.textContent = info.isLocal ? 'You' : id; // Display full ID or 'You'
        p.appendChild(avatar);
        p.appendChild(name);
        participantsDiv.appendChild(p);
    });
}

/**
 * Adds a video element to the UI for a given media stream.
 * @param {MediaStream} stream - The media stream to display.
 * @param {string} label - A label for the video (e.g., user ID or 'You').
 * @param {boolean} [isLocal=false] - True if this is the local user's video.
 */
function addVideo(stream, label, isLocal = false) {
    const card = document.createElement('div');
    card.className = 'video-card';
    const video = document.createElement('video');
    video.autoplay = true; // Automatically play the video
    video.playsInline = true; // Play inline on mobile devices
    video.srcObject = stream; // Set the media stream as the video source
    video.setAttribute('data-label', label); // Store the label for potential removal later

    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = label;

    card.appendChild(video);
    card.appendChild(labelDiv);
    videosDiv.appendChild(card);

    // Update the participants data structure and refresh the UI list.
    if (isLocal) {
        participants['you'] = { isLocal: true };
    } else {
        // For remote participants, the label is typically their socket ID.
        participants[label] = { isLocal: false };
    }
    updateParticipants();
}

// Event handler for the "Join Conference" button.
joinBtn.onclick = async () => {
    joinBtn.disabled = true; // Disable button to prevent multiple clicks
    spinner.style.display = 'flex'; // Show loading spinner

    try {
        // Check for MediaDevices API and getUserMedia support.
        if (!navigator.mediaDevices) {
            throw new Error('navigator.mediaDevices is not defined');
        }
        if (!navigator.mediaDevices.getUserMedia) {
            throw new Error('navigator.mediaDevices.getUserMedia is not defined');
        }

        // Get local audio and video stream.
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        addVideo(localStream, 'You', true); // Display local video
        showToast('Joined conference!');

        // Update UI button states.
        joinBtn.disabled = true; // Keep join button disabled
        leaveBtn.style.display = 'inline-block'; // Show leave button
        toggleAudioBtn.style.display = 'inline-block'; // Show mute button
        toggleAudioBtn.textContent = isAudioMuted ? 'Unmute Audio' : 'Mute Audio';

        // --- Mediasoup Client Signaling Flow ---

        // 1. Get Router RTP Capabilities from the server.
        // This tells the client what media codecs and parameters the server's router supports.
        const routerRtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
        
        // 2. Load the mediasoup Device.
        // The device instance represents this client's WebRTC capabilities, informed by the router's capabilities.
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });

        // 3. Create Send Transport on the client.
        // This transport will be used to send local media to the server.
        // The server provides transport parameters (id, iceParameters, etc.).
        const sendTransportInfo = await new Promise(res => socket.emit('createWebRtcTransport', { type: 'send' }, res));
        sendTransport = device.createSendTransport(sendTransportInfo);

        // 'connect' event for Send Transport: Triggered when transport.produce() is called.
        // Requires DTLS parameters from the client to establish a secure connection with the server-side transport.
        sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, ({ connected, error }) => {
                if (connected) {
                    callback(); // DTLS handshake successful
                } else {
                    errback(error); // DTLS handshake failed
                }
            });
        });

        // 'produce' event for Send Transport: Triggered when a new track is added via transport.produce().
        // The client sends details (kind, rtpParameters) to the server to create a server-side Producer.
        sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
            // `appData` can be passed from `sendTransport.produce({ track, appData })` if needed.
            socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters, appData }, ({ id, error }) => {
                if (id) {
                    callback({ id }); // Server successfully created the producer, returns its ID.
                } else {
                    errback(error); // Server failed to create the producer.
                }
            });
        });

        // 4. Create Receive Transport on the client.
        // This transport will be used to receive media from the server (from other peers).
        const recvTransportInfo = await new Promise(res => socket.emit('createRecvTransport', res));
        recvTransport = device.createRecvTransport(recvTransportInfo);

        // 'connect' event for Receive Transport. Similar to send transport, for DTLS handshake.
        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters }, ({ connected, error }) => {
                if (connected) {
                    callback();
                } else {
                    errback(error);
                }
            });
        });
        
        // 5. Produce local media tracks (audio and video).
        // For each track in the localStream, create a producer on the sendTransport.
        for (const track of localStream.getTracks()) {
            // `track` is the MediaStreamTrack (audio or video).
            // Additional options like encodings or appData can be passed here if needed.
            const producer = await sendTransport.produce({ track });
            producers.push(producer); // Store local producers
        }

        // 6. Consume existing media from other peers.
        // Request a list of existing producers from the server.
        const existingProducers = await new Promise(res => socket.emit('getProducers', res));
        for (const { socketId: remoteSocketId, producerId, kind, appData: remoteProducerAppData } of existingProducers) {
            if (!device || !recvTransport) continue; // Ensure device and recvTransport are initialized.
            
            // For each existing producer, create a consumer on the client.
            const consumerParameters = await new Promise(res => 
                socket.emit('consume', { producerId, rtpCapabilities: device.rtpCapabilities, transportId: recvTransport.id }, res)
            );

            if (consumerParameters.error) {
                console.error(`Error consuming existing producer ${producerId}:`, consumerParameters.error);
                continue;
            }

            // Use the server-provided parameters to create a client-side consumer.
            const consumer = await recvTransport.consume({
                id: consumerParameters.id,
                producerId: consumerParameters.producerId,
                kind: consumerParameters.kind,
                rtpParameters: consumerParameters.rtpParameters,
                appData: remoteProducerAppData // Store appData from the remote producer
            });
            
            // The server might create the consumer paused; client needs to resume it.
            // However, our server creates consumers unpaused. If it were paused, a resume signal would be needed.
            // await socket.emit('resumeConsumer', { consumerId: consumer.id }); // Example if server created paused
            
            // Create a new MediaStream from the consumer's track and display it.
            const remoteStream = new MediaStream([consumer.track]);
            addVideo(remoteStream, remoteSocketId); // Label with the producer's socket ID
        }

        spinner.style.display = 'none'; // Hide spinner after setup
    } catch (err) {
        showToast('Could not join: ' + err.message, true);
        joinBtn.disabled = false; // Re-enable join button on error
        spinner.style.display = 'none';
    }
};

// Listen for 'newProducer' events from the server.
// This event is emitted when another client starts sending a new media track.
socket.on('newProducer', async ({ socketId: remoteSocketId, producerId, kind, appData: remoteProducerAppData }) => {
    if (!device || !recvTransport) {
        console.warn('Received newProducer event but device or recvTransport not ready.');
        return;
    }
    console.log(`New producer from ${remoteSocketId}`, { producerId, kind, appData: remoteProducerAppData });

    // Request to consume this new producer.
    // Provide client's RTP capabilities to ensure compatibility.
    const consumerParameters = await new Promise(res => 
        socket.emit('consume', { producerId, rtpCapabilities: device.rtpCapabilities, transportId: recvTransport.id }, res)
    );

    if (consumerParameters.error) {
        console.error(`Error consuming new producer ${producerId}:`, consumerParameters.error);
        return;
    }

    // Create a client-side consumer using parameters from the server.
    const consumer = await recvTransport.consume({
        id: consumerParameters.id,
        producerId: consumerParameters.producerId,
        kind: consumerParameters.kind,
        rtpParameters: consumerParameters.rtpParameters,
        appData: remoteProducerAppData // Store appData from the remote producer
    });

    // Create a new MediaStream from the consumer's track and display it.
    const remoteStream = new MediaStream([consumer.track]);
    addVideo(remoteStream, remoteSocketId); // Label with the producer's socket ID
    showToast(`Participant ${remoteSocketId.slice(0,4)}... joined!`);
});

// Event handler for the "Leave Conference" button.
leaveBtn.onclick = () => {
    // 1. Close local media producers.
    producers.forEach(p => p.close());
    producers = [];

    // 2. Close mediasoup transports (send and receive).
    if (sendTransport) {
        sendTransport.close();
        sendTransport = null;
    }
    if (recvTransport) {
        recvTransport.close();
        recvTransport = null;
    }

    // 3. Stop local media tracks (camera, microphone).
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // 4. Clear video elements from the UI and reset participant list.
    videosDiv.innerHTML = '';
    participants = {}; 
    updateParticipants(); 

    // 5. Disconnect the Socket.IO socket.
    // This will trigger the 'disconnect' event on the server for cleanup there.
    if (socket && socket.connected) {
        socket.disconnect();
    }

    // 6. Reset UI button states.
    joinBtn.disabled = false; // Enable join button
    leaveBtn.style.display = 'none'; // Hide leave button
    toggleAudioBtn.style.display = 'none'; // Hide mute button
    isAudioMuted = false; // Reset mute state

    showToast('You have left the conference.');
    
    // Optional: If rejoining without page reload is desired, the socket might need to be reconnected.
    // For this app, a page reload would be simpler if rejoining.
    // socket.connect(); // If explicitly managing re-connection.
};

// Event handler for the "Mute/Unmute Audio" button.
toggleAudioBtn.onclick = () => {
    if (!localStream) return; // No local stream to mute/unmute

    isAudioMuted = !isAudioMuted; // Toggle mute state
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length > 0) {
        // Enable/disable the first audio track.
        // `enabled = true` means unmuted, `false` means muted.
        audioTracks[0].enabled = !isAudioMuted; 
        toggleAudioBtn.textContent = isAudioMuted ? 'Unmute Audio' : 'Mute Audio';
        showToast(isAudioMuted ? 'Audio muted' : 'Audio unmuted');
    } else {
        showToast('No audio track found to mute/unmute.', true);
    }
};

// Listen for 'participantLeft' events from the server.
// This event is emitted when another client disconnects.
socket.on('participantLeft', ({ socketId }) => {
    console.log(`Participant ${socketId} left`);
    // Find and remove the video card associated with the departed participant.
    // The video element's `data-label` attribute should match the socketId.
    const videoCardToRemove = document.querySelector(`video[data-label='${socketId}']`);
    if (videoCardToRemove && videoCardToRemove.parentElement.classList.contains('video-card')) {
        videoCardToRemove.parentElement.remove();
    }
    // Remove the participant from the local data structure and update the UI list.
    delete participants[socketId];
    updateParticipants();
    showToast(`Participant ${socketId.slice(0,4)}... left`);
});

// Handle Socket.IO 'disconnect' event (e.g., server restart, network issue).
socket.on('disconnect', () => {
    showToast('Disconnected from server. You might need to rejoin.', true);
    
    // Clean up client-side mediasoup objects and UI elements.
    producers.forEach(p => p.close());
    producers = [];
    if (sendTransport) { sendTransport.close(); sendTransport = null; }
    if (recvTransport) { recvTransport.close(); recvTransport = null; }
    
    // Optionally, keep local video showing if localStream still exists,
    // but clear remote videos.
    videosDiv.innerHTML = ''; 
    const localVideoCard = document.querySelector(`video[data-label='You']`);
    if (localVideoCard && localVideoCard.parentElement && localStream) { 
         videosDiv.appendChild(localVideoCard.parentElement); // Re-add local video if it was there
    } else if (localStream) { 
        // If card was removed but stream exists, re-add it (e.g. if innerHTML cleared everything)
        addVideo(localStream, 'You', true); 
    }

    // Reset participant list, keeping local user if stream is active.
    const localParticipantInfo = participants['you'];
    participants = {};
    if (localParticipantInfo && localStream) {
        participants['you'] = localParticipantInfo;
    }
    updateParticipants();

    // Reset UI button states to allow rejoining.
    joinBtn.disabled = false; 
    leaveBtn.style.display = 'none';
    toggleAudioBtn.style.display = 'none';
    isAudioMuted = false;
});
