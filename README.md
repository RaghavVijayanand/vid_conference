# Video Conference SFU (Selective Forwarding Unit)

This project is a video conferencing application built using Node.js, Express, Socket.IO for signaling, and mediasoup for WebRTC media routing (SFU architecture). The client-side is built with plain JavaScript and uses Vite for development and bundling.

## Features

*   Multi-party video/audio conferencing.
*   Selective Forwarding Unit (SFU) architecture using mediasoup for efficient media routing.
*   Real-time signaling with Socket.IO.
*   Dynamic participant list.
*   "Mute/Unmute Audio" functionality for local audio control.
*   "Leave Conference" button to gracefully exit the session.
*   Basic UI with a participants sidebar and video grid.

## Technologies Used

*   **Backend**:
    *   Node.js
    *   Express.js
    *   Socket.IO
    *   mediasoup
*   **Frontend**:
    *   JavaScript (ES Modules)
    *   mediasoup-client
    *   Vite (for development and bundling)
*   **Testing**:
    *   Jest (for server-side unit tests)

## Project Structure

*   `server.js`: Main Node.js server entry point. Initializes Express, HTTPS, Socket.IO, and the mediasoup/socket handlers.
*   `mediasoup-handler.js`: Server-side module responsible for all mediasoup-related logic, including worker/router setup, transport creation, and media production/consumption.
*   `socket-handler.js`: Server-side module that manages all Socket.IO event handling for signaling, client connections, and interactions with `mediasoup-handler.js`.
*   `public/`: Contains static client-side files.
    *   `index.html`: The main HTML file for the client application.
    *   `style.css`: CSS styles for the client application.
    *   `mediasoupclient.js`: (Note: This might be part of the bundle if using npm package for mediasoup-client, verify actual setup) Mediasoup client library.
*   `src/`: Contains client-side JavaScript source files.
    *   `client.js`: Main client-side script handling UI, Socket.IO communication, and mediasoup-client logic.
*   `__tests__/`: Contains server-side Jest unit tests.
    *   `socket-handler.test.js`: Unit tests for the socket handler module.
*   `key.pem`, `cert.pem`: SSL certificates for running the server over HTTPS. **Generate your own for local testing or use valid certificates for deployment.**
*   `package.json`: Lists project dependencies and npm scripts.
*   `package-lock.json`: Records exact versions of dependencies.
*   `vite.config.js`: Configuration file for Vite.

## Setup and Running

1.  **Clone the repository:**
    ```bash
    git clone <repository_url>
    cd <repository_directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Generate SSL Certificates (for local testing):**
    For HTTPS to work, you need SSL certificates. You can create self-signed certificates using OpenSSL:
    ```bash
    openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
    ```
    Place `key.pem` and `cert.pem` in the project root directory.
    *   **Note for Production:** For a public server, use certificates signed by a trusted Certificate Authority (CA).
    *   You can also specify certificate paths using `SSL_KEY_FILE` and `SSL_CERT_FILE` environment variables.

4.  **Configure Announced IP:**
    Mediasoup requires an `announcedIp` for its WebRTC transports. This is the IP address that clients will use to connect to the server for media.
    *   **Public Deployment:** Set this to your server's public IP address.
    *   **LAN Testing:** Set this to your server's LAN IP address (e.g., `192.168.1.100`).
    *   **Local Machine Testing (Client and Server on same host):** If not set, it defaults to `127.0.0.1`.

    Set the `ANNOUNCED_IP` environment variable when starting the server:
    ```bash
    ANNOUNCED_IP=your_server_ip node server.js
    ```
    Replace `your_server_ip` with the appropriate IP address.

5.  **Start the server:**
    ```bash
    # Example for LAN testing (replace with your LAN IP)
    # ANNOUNCED_IP=192.168.1.100 node server.js
    
    # Example for local machine testing
    node server.js 
    ```
    The server will typically run on `https://localhost:3000` or `https://your_server_ip:3000`.

6.  **Start the client (using Vite):**
    In a new terminal, navigate to the project directory and run:
    ```bash
    npx vite --port 3001 --host
    ```
    This starts the Vite development server, usually accessible at `http://localhost:3001` (Vite uses HTTP by default for its dev server, but the client will connect to the HTTPS backend).

7.  **Open the client in your browser:**
    Navigate to the address provided by Vite (e.g., `http://localhost:3001`). Your browser will likely show a warning for the self-signed certificate used by the backend server; you'll need to accept it to proceed.

## Running Tests

Server-side unit tests are written using Jest. To run them:
```bash
npm test
```

## Security Configuration Summary

*   **HTTPS Certificates:** Generate `key.pem` and `cert.pem` (self-signed for local, CA-signed for production). Place them in the root or set `SSL_KEY_FILE` / `SSL_CERT_FILE` environment variables.
*   **Announced IP for Mediasoup:** Set the `ANNOUNCED_IP` environment variable to the server's accessible IP address (public IP for production, LAN IP for local network testing). Defaults to `127.0.0.1` if not set.

## How It Works (Simplified Flow)

1.  **Client Connection:** Client connects to the Socket.IO server.
2.  **Joining:** Client clicks "Join", gets local media, and then:
    *   Fetches Router RTP capabilities from the server.
    *   Loads mediasoup Device with these capabilities.
    *   Creates a "send" WebRTC transport (client asks server, server creates, sends params back).
    *   Connects the send transport using DTLS parameters.
    *   Creates a "receive" WebRTC transport similarly.
    *   Starts producing local audio/video tracks using the send transport.
    *   Fetches existing producers from other participants and consumes them using the receive transport.
3.  **New Participant:** When another user joins and produces media, the server emits a `newProducer` event. Existing clients consume this new producer.
4.  **Leaving:** Client clicks "Leave", closing local producers, transports, and disconnecting the socket. Other clients are notified via `participantLeft`.
5.  **Mute/Unmute:** Toggles the `enabled` state of the local audio track.

This project demonstrates a foundational SFU-based video conferencing setup. Further enhancements could include features like screen sharing, chat, improved UI/UX, robust error handling, and scalability considerations for larger conferences.
