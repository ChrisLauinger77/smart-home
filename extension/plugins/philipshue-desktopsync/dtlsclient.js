'use strict';

/**
 * dtls
 * JavaScript implementation of DTLS Client for Philips Hue Bridge.
 *
 * @author Václav Chlumský
 * @copyright Copyright 2025, Václav Chlumský.
 */

 /**
 * @license
 * The MIT License (MIT)
 *
 * Copyright (c) 2025 Václav Chlumský
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Utils from '../../utils.js';
import * as hashing from '../../crypto/hashing.js';
import * as gcm from '../../crypto/gcm.js';

/* https://tools.ietf.org/html/rfc6347#section-4.3.2 */

const DTLS_MASTER_SECRET_LENGTH = 48;

const handshakeType = {
    HELLO_REQUEST: 0,
    CLIENT_HELLO: 1,
    SERVER_HELLO: 2,
    HELLO_VERIFY_REQUEST: 3,
    CERTIFICATE: 11,
    SERVER_KEY_EXCHANGE: 12,
    CERTIFICATE_REQUEST: 13,
    SERVER_HELLO_DONE: 14,
    CERTIFICATE_VERIFY: 15,
    CLIENT_KEY_EXCHANGE: 16,
    FINISHED: 20,
};
  
const contentType = {
    CHANGE_CIPHER_SPEC: 20,
    ALERT: 21,
    HANDSHAKE: 22,
    APPLICATION_DATA: 23,
};
  
const protocolVersion = {
    DTLS_1_0: 0xfeff,
    DTLS_1_2: 0xfefd,
};
  
const cipherSuites = {
    TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 0xc02b,
    TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: 0xc02c,
    TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 0xc02f,
    TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: 0xc030,
    TLS_RSA_WITH_AES_128_GCM_SHA256: 0x009c,
    TLS_RSA_WITH_AES_256_GCM_SHA384: 0x009d,
    TLS_PSK_WITH_AES_128_GCM_SHA256: 0x00a8,
    TLS_PSK_WITH_AES_256_GCM_SHA384: 0x00a9,
    TLS_ECDHE_PSK_WITH_AES_128_GCM_SHA256: 0xd001,
    TLS_ECDHE_PSK_WITH_AES_256_GCM_SHA384: 0xd002,
    TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256: 0xccac,
    TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256: 0xcca9,
    TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256: 0xcca8,
    TLS_PSK_WITH_CHACHA20_POLY1305_SHA256: 0xccab,
};

/**
 * Returns random number up to max value
 * 
 * @method getRandomInt
 * @param {Number} maximum value
 * @return {Number} random number
 */
export function getRandomInt(max) {
    return Math.floor(Math.random() * Math.floor(max));
}

/**
 * Converts number to array of bytes
 * 
 * @method uintToArray
 * @param {Number} number for conversion
 * @param {Number} desired length of array
 * @return {Object} array of bytes
 */
export function uintToArray(number, length) {
    let a = [];

    if (length >= 48) {
        a.push((number & 0xFF00000000) >> 40);
    }

    if (length >= 40) {
        a.push((number & 0xFF00000000) >> 32);
    }

    if (length >= 32) {
        a.push((number & 0xFF000000) >> 24);
    }
    
    if (length >= 24) {
        a.push((number & 0xFF0000) >> 16);
    }

    if (length >= 16) {
        a.push((number & 0xFF00) >> 8);
    }

    if (length >= 8) {
        a.push(number & 0xFF);
    }

    return a;
}

/**
 * Converts array of bytes to number
 * 
 * @method arrayToUint
 * @param {Object} array of bytes
 * @return {Number} number
 */
export function arrayToUint(a) {
    let number = 0x0;

    for (let i in a) {
        number = number << 8;
        number = number | a[i];
    }

    return number;
}

/**
 * Converts number to array as big as possible
 * 
 * @method bytesUpToArray
 * @param {Number} number for conversion
 * @return {Object} array of bytes
 */
export function bytesUpToArray(number) {
    let a = [];
    let mask = 0xFF;

    if (number === 0) {
        return [0x00];
    }

    while (number > 0) {
        a.unshift(number & mask);
        number = number >> 8;
    }

    return a;
}

/**
 * Converts string to array of bytes
 * 
 * @method stringToArray
 * @param {String} strong for conversion
 * @return {Object} array of bytes
 */
export function stringToArray(s) {
    let a = [];
    let charCode;
    for (let i = 0; i < s.length; i++) {
        charCode = s.charCodeAt(i);
        a = a.concat(uintToArray(charCode, 8));
    }
    return a;
}

/**
 * DTLSClient class. Provides clinet socket via UDP DTLS.
 * 
 * @class DTLSClient
 * @constructor
 * @return {Object} DTLS client
 */
export const DTLSClient =  GObject.registerClass({
    GTypeName: "SmartHomeDTLSClient",
    Properties: {
        "ip": GObject.ParamSpec.string("ip", "ip", "ip", GObject.ParamFlags.READWRITE, null),
        "port": GObject.ParamSpec.int("port", "port", "port", GObject.ParamFlags.READWRITE, 0, 65534, 2100),
        "psk": GObject.ParamSpec.string("psk", "psk", "psk", GObject.ParamFlags.READWRITE, null),
        "pskidentity": GObject.ParamSpec.string("pskidentity", "pskidentity", "pskidentity", GObject.ParamFlags.READWRITE, null),
    },
    Signals: {
        "connected": {},
        "disconnected": {}
    }
}, class DTLSClient extends GObject.Object {

    /**
     * DTLSClient class initialization
     *  
     * @method _init
     * @private
     */
    _init(props={}) {
        super._init(props);

        this.timers = [];
        this._handshakeInProgress = true;
        this._connection = null;
        this._dataInputStream = null;
        this._outputStream = null;
        this._clientSocket = null;
        this._protocolVersion = protocolVersion.DTLS_1_2;
        this._cipherSuites = cipherSuites.TLS_PSK_WITH_AES_128_GCM_SHA256;
        this._handshakeMessages = {};
        this._encrypted = false;
    }

    set ip(value) {
        this._ip = value;
    }

    get ip() {
        return this._ip;
    }

    set port(value) {
        this._port = value;
    }

    get port() {
        return this._port;
    }

    set pskidentity(value) {
        this._pskIdentity = value;
    }

    get pskidentity() {
        return this._pskIdentity;
    }

    set psk(value) {
        this._psk = value;
    }

    get psk() {
        return this._psk;
    }

    /**
     * Connect to Philips Hue bridge via DTLS using UDP
     * 
     * @method connectBridge
     */
    connectBridge() {
        let address = Gio.InetSocketAddress.new_from_string(
            this._ip,
            this._port
        );

        this._clientSocket = new Gio.SocketClient({
            family: Gio.SocketFamily.IPV4,
            type: Gio.SocketType.DATAGRAM,
            protocol: Gio.SocketProtocol.UDP
        });

        //this._clientSocket.set_timeout(3);

        this._clientSocket.connect_async(
            address,
            null,
            (o, res) =>  {
                this._connection = this._clientSocket.connect_finish(res);
                if (!this._connection) {
                    Utils.logError("DTLS connection to bridge not established.");
                    return;
                }

                this._connection.get_socket().set_blocking(false);

                this._dataInputStream = new Gio.DataInputStream({
                    "base_stream": this._connection.get_input_stream()
                });

                this._ouputCancelleable = new Gio.Cancellable();
                this._outputStream = this._connection.get_output_stream();

                this._inputCancelleable = new Gio.Cancellable();
                this._readResponse();

                let attemptCounter = 0;
                this._initiateHandshake(attemptCounter);
            }
        );
    }

    _initiateHandshake(attemptCounter) {
        this._ouputCancelleable.reset();
        if (attemptCounter > 2) {
            return;
        }

        this._sendHandshakeRequest();

        let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this.timers = Utils.removeFromArray(this.timers, timerId);

            /* if  the handshake is still in progress, we have probably lost some UDP data, try again */
            if (this._handshakeInProgress) {
                this._ouputCancelleable.cancel();
                this._initiateHandshake(++ attemptCounter);
            }
            return GLib.SOURCE_REMOVE;
        });

        this.timers.push(timerId);
    }

    /**
     * Disconnect from bridge
     * 
     * @method closeBridge
     */
    closeBridge() {
        this.clearTimers();

        if (! this._connection) {
            return;
        }
        this._ouputCancelleable.cancel();
        this._inputCancelleable.cancel();
        this._connection.get_socket().close();
        this.emit("disconnected");
    }

    /**
     * Send initial DTLS handshake request
     * 
     * @method _sendHandshakeRequest
     */
    async _sendHandshakeRequest() {
        let packet = {
            "cType": contentType.HANDSHAKE,
            "hType": handshakeType.CLIENT_HELLO,
            "epoch": 0,
            "headerSeq": 0,
            "sessionId": 0,
            "cookie": 0,
            "handshakeSeq": 0
        };

        this._encrypted = false;
        let msg = this._createPacket(packet);
        this._sendMsg(msg, null);

        this._helloClientPacket = packet;
    }

    /**
     * Sends a message via socket (asynchronous)
     * 
     * @method _sendMsg
     * @param {Object} array of bytes for sending
     * @param {Object} callbeck to be called after sending msg
     */
    _sendMsg(msg, callback) {
        this._loghex("sending a message:", msg);
        this._outputStream.write_all_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            this._ouputCancelleable,
            (o, res) => {
                this._outputStream.write_all_finish(res);
                if (callback != null) {
                    callback.call(this);
                }
            }
        );
    }

    /**
     * Reads data from socket and pass the data into
     * packet handler
     * 
     * @method _readResponse
     */
    _readResponse() {
        this._dataInputStream.fill_async(
            -1,
            GLib.PRIORITY_DEFAULT,
            this._inputCancelleable,
            (o, res) => {
                if (this._dataInputStream.is_closed()) {

                    Utils.logDebug("DTLS stream is closed.");
                    return;
                }

                let fillSize;
                try {
                    fillSize = this._dataInputStream.fill_finish(res);
                } catch (e) {
                    fillSize = 0;

                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PENDING)) {
                        Utils.logDebug(`DTLS client is already reading, skipping.`);
                        return;
                    }

                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED)) {
                        Utils.logDebug(`DTLS client closed.`);
                        return;
                    }

                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        Utils.logDebug(`DTLS client closed.`);
                        return;
                    }

                    Utils.logError(`DTLS client failed to finish reading: ${e}`);
                    return;
                }

                if (fillSize > 0) {

                    let msg = [];

                    for (let i = 0; i < fillSize; i++) {
                        msg.push(this._dataInputStream.read_byte(null));
                    }

                    while(msg.length !== 0) {
                        let packet = this._readPacket(msg);

                        this._handleResponse(packet);
                    }

                }
                this._readResponse();
            }
        );
    }

    /**
     * Returns array of bytes with DTLS message header
     * 
     * @method _createRecordHeader
     * @param {Object} outcomming packet 
     * @param {Number} length of body data
     * @return {Object} array of bytes
     */
    _createRecordHeader(packet, length) {
        let message = []

        /* concent type */
        message = message.concat(uintToArray(packet["cType"], 8));

        /* protocol version */
        message = message.concat(uintToArray(this._protocolVersion, 16));

        /* epoch */
        message = message.concat(uintToArray(packet["epoch"], 16));

        /* sequence number */
        message = message.concat(uintToArray(packet["headerSeq"], 48));

        /* length */
        message = message.concat(uintToArray(length, 16));

        return message;
    }

    /**
     * Returns array of bytes with DTLS client hello
     * handshake message body
     * 
     * @method _createHandshakeClientHelloBody
     * @param {Object} outcomming packet 
     * @return {Object} array of bytes
     */
    _createHandshakeClientHelloBody(packet) {
        let handshakeBody = [];
        let time = [];

        /* protocol version */
        handshakeBody = handshakeBody.concat(uintToArray(this._protocolVersion, 16));

        /* time */
        time = uintToArray(0, 32);
        handshakeBody = handshakeBody.concat(time);

        /* random */
        let random = packet["random"];
        if (random === undefined) {
            random = [];
            for (let i = 0; i < 28; i++) {
                let rnd = getRandomInt(0xFF);
                random = random.concat(uintToArray(rnd, 8));
            }

            packet["random"] = random;
            this._clientRandom = time.concat(random);
        }
        handshakeBody = handshakeBody.concat(packet["random"]);

         /* session ID */
         if (packet["sessionId"] === 0) {
            handshakeBody = handshakeBody.concat(uintToArray(0, 8));
         } else {
            let sessionIDbytes = this.bytesUpToArray(packet["sessionId"]);
            handshakeBody = handshakeBody.concat(uintToArray(sessionIDbytes.length, 8));
            handshakeBody = handshakeBody.concat(sessionIDbytes);
         }

        /* cookie */
        if (packet["cookie"] === 0) {
            handshakeBody = handshakeBody.concat([0x0]);
        } else {
            handshakeBody = handshakeBody.concat(uintToArray(packet["cookie"].length, 8));
            handshakeBody = handshakeBody.concat(packet["cookie"]);
        }

        /* cipher suites */
        let cipherSuitesBytes = uintToArray(this._cipherSuites, 16)
        handshakeBody = handshakeBody.concat(uintToArray(cipherSuitesBytes.length, 16));
        handshakeBody = handshakeBody.concat(cipherSuitesBytes);

        handshakeBody = handshakeBody.concat(uintToArray(1, 8));
        handshakeBody = handshakeBody.concat(uintToArray(0, 8));
        
        return handshakeBody;
    }

    /**
     * Returns array of bytes with DTLS Client key exchange
     * handshake message body
     * 
     * @method _createHandshakeClientKeyExchangeBody
     * @param {Object} outcomming packet 
     * @return {Object} array of bytes
     */
    _createHandshakeClientKeyExchangeBody(packet) {
        let handshakeBody = [];

        Utils.logDebug("ClientKeyExchange psk identity: " + this._pskIdentity);

        /* psk identity lenght */
        handshakeBody = handshakeBody.concat(uintToArray(this._pskIdentity.length, 16));

        /* psk identity */
        handshakeBody = handshakeBody.concat(stringToArray(this._pskIdentity));

        return handshakeBody;
    }

    /**
     * Hash function used by DTLS
     * 
     * @method P_hash
     * @param {Object} secret
     * @param {Object} seed
     * @return {Object} hash
     */
    P_hash(secret, seed) {
        let res = [];

        hashing.hashing.hmac_hash = hashing.hashing.sha256;

        /* Ai is A1 for now */
        let Ai = hashing.hashing.HMAC(secret, seed);

        while(res.length < DTLS_MASTER_SECRET_LENGTH) {
            res = res.concat(hashing.hashing.HMAC(secret, Ai.concat(seed)));

            Ai = hashing.hashing.HMAC(secret, Ai);
        }

        let a = [];
        for (let i = 0; i < DTLS_MASTER_SECRET_LENGTH; i++) {
            a.push(res[i]);
        }

        return a;
    }

    /**
     * Pseudo random function used by DTLS
     * 
     * @method PRF
     * @param {Object} secret
     * @param {Object} label
     * @param {Object} seed
     * @return {Object} hash
     */
    PRF(secret , label, seed) {
        let res = [];
        res = this.P_hash(secret, stringToArray(label).concat(seed));
        return res;
    }

    /**
     * Returns array of bytes with DTLS finished
     * handshake message body
     * 
     * @method _createHandshakeFinishedBody
     * @param {Object} outcomming packet 
     * @return {Object} array of bytes
     */
    _createHandshakeFinishedBody(packet) {
        let handshakeBody = [];

        let preMasterSecret = [];

        preMasterSecret = preMasterSecret.concat(uintToArray(this._psk.length / 2, 16));
        for (let i = 0; i < 16; i++) {
            preMasterSecret = preMasterSecret.concat(uintToArray(0, 8));
        }
        preMasterSecret = preMasterSecret.concat(uintToArray(this._psk.length / 2, 16));
        for (let i = 0; i < this._psk.length; i = i + 2) {
            preMasterSecret.push(parseInt("0x" + this._psk[i] + this._psk[i + 1]));
        }

        this._loghex("preMasterSecret: ", preMasterSecret);
        this._loghex("client random: ", this._clientRandom);
        this._loghex("server random: ", this._serverRandom);

        this._masterSecret = this.PRF(
            preMasterSecret,
            "master secret",
            this._clientRandom.concat(this._serverRandom)
        );

        this._keyBlock = this.PRF(
            this._masterSecret,
            "key expansion",
            this._serverRandom.concat(this._clientRandom)
        );

        this._clientWriteKey = this._keyBlock.slice(0, 16);
        this._serverWriteKey = this._keyBlock.slice(16, 32);
        this._clientIV = this._keyBlock.slice(32, 36);
        this._serverIV = this._keyBlock.slice(36, 40);

        /* https://www.cryptologie.net/article/353/dtls-and-finished-messages/ */
        let handshakeMsg = [];
        handshakeMsg = handshakeMsg.concat(this._handshakeMessages[handshakeType.CLIENT_HELLO]);
        handshakeMsg = handshakeMsg.concat(this._handshakeMessages[handshakeType.SERVER_HELLO]);
        handshakeMsg = handshakeMsg.concat(this._handshakeMessages[handshakeType.SERVER_HELLO_DONE]);
        handshakeMsg = handshakeMsg.concat(this._handshakeMessages[handshakeType.CLIENT_KEY_EXCHANGE]);
        let finishMsg = this.PRF(
            this._masterSecret,
            "client finished",
            hashing.hashing.sha256.hash(handshakeMsg)
        );

        handshakeBody = finishMsg.slice(0,12);

        this._loghex("master key: ", this._masterSecret);
        this._loghex("key block: ", this._keyBlock);
        this._loghex("client write key: ", this._clientWriteKey);
        this._loghex("server write key: ", this._serverWriteKey);
        this._loghex("client IV: ", this._clientIV);
        this._loghex("server IV: ", this._serverIV);

        return handshakeBody;
    }

    /**
     * Creates handshake header and body
     * 
     * @method _createHandshake
     * @param {Object} outcomming packet 
     * @return {Object} array of bytes
     */
    _createHandshake(packet) {
        let handshakeMsg = [];
        let handshakeBody = [];

        switch (packet["hType"]) {
            case handshakeType.CLIENT_HELLO:
                handshakeBody = this._createHandshakeClientHelloBody(packet);
                break;

            case handshakeType.CLIENT_KEY_EXCHANGE:
                handshakeBody = this._createHandshakeClientKeyExchangeBody(packet);
                break;

            case handshakeType.FINISHED:
                handshakeBody = this._createHandshakeFinishedBody(packet);
                break;

            default:
                return [];
        }

        /* handshake type */
        handshakeMsg = handshakeMsg.concat(uintToArray(packet["hType"], 8));

        /* handshake body lenght */
        handshakeMsg = handshakeMsg.concat(uintToArray(handshakeBody.length, 24));

        /* sequence number */
        handshakeMsg = handshakeMsg.concat(uintToArray(packet["handshakeSeq"], 16));

        /* fragment offset */
        handshakeMsg = handshakeMsg.concat(uintToArray(0, 24));

        /* fragment length */
        handshakeMsg = handshakeMsg.concat(uintToArray(handshakeBody.length, 24));

        handshakeMsg = handshakeMsg.concat(handshakeBody);

        if (packet["hType"] == handshakeType.FINISHED) {
            handshakeMsg = this._encryptMsg(packet, handshakeMsg);

            this._logDecryptionData("client", packet, handshakeMsg);
        }

        this._handshakeMessages[packet["hType"]] = handshakeMsg;
        return handshakeMsg;
    }


    /**
     * Creates message from packet
     * 
     * @method _createPacket
     * @param {Object} outcomming packet 
     * @return {Object} array of bytes
     */
    _createPacket(packet) {
        let message = [];
        let body = [];

        switch (packet["cType"]) {
            case contentType.HANDSHAKE:
                body = this._createHandshake(packet);
                break;

            case contentType.CHANGE_CIPHER_SPEC:
                body = [0x01];
                break;

            default:
                return [];
        }

        let recordHeader = this._createRecordHeader(packet, body.length);

        message = message.concat(recordHeader);
        message = message.concat(body);

        return message;
    }

    /**
     * Remove and return n items from message array
     * 
     * @method popNextN
     * @param {Object} msg array to by modified
     * @param {Number} number of items to pop
     * @return {Object} array of bytes
     */
    popNextN(msg, n) {
        let popped = [];
        for (let i = 0; i < n; i++) {
            popped.push(msg.shift())
        }
        return popped;
    }

    /**
     * Reads handshake message body.
     * 
     * @method _readHandshakePacket
     * @param {Object} msg array to by read
     * @param {Number} type of handshake message
     * @return {Object} packet with data
     */
    _readHandshakePacket(msg, hType) {
        let subPacket = {};

        switch(hType) {
            case handshakeType.HELLO_VERIFY_REQUEST:
                subPacket["protocolVersionH"] = arrayToUint(this.popNextN(msg, 2));
                subPacket["cookieLegth"] = arrayToUint(this.popNextN(msg, 1));
                subPacket["cookie"] = this.popNextN(msg, subPacket["cookieLegth"]);
                break;

            case handshakeType.SERVER_HELLO:
                subPacket["protocolVersionH"] = arrayToUint(this.popNextN(msg, 2));
                subPacket["time"] = this.popNextN(msg, 4);
                subPacket["random"] = this.popNextN(msg, 28);
                subPacket["sessionIdLength"] = arrayToUint(this.popNextN(msg, 1));
                subPacket["sessionId"] = this.popNextN(msg, subPacket["sessionIdLength"]);
                subPacket["cipherSuite"] = arrayToUint(this.popNextN(msg, 2));

                this._serverRandom = subPacket["time"].concat(subPacket["random"]);
                break;

            case handshakeType.SERVER_HELLO_DONE:
                break;

            case handshakeType.FINISHED:
                break;
        }

        return subPacket;
    }

    /**
     * Reads message into packet.
     * 
     * @method _readPacket
     * @param {Object} msg array to by read
     * @return {Object} packet with data
     */
    _readPacket(msg) {
        let packet = {};
        let handshakeBodyLength;
        let handshakeBody;
        this._loghex("incomming data", msg);
        packet["cType"] = arrayToUint(this.popNextN(msg, 1));
        packet["protocolVersion"] = arrayToUint(this.popNextN(msg, 2));
        packet["epoch"] = arrayToUint(this.popNextN(msg, 2));
        packet["headerSeq"] = arrayToUint(this.popNextN(msg, 6));

        let bodyLength = arrayToUint(this.popNextN(msg, 2));
        let bodyMsg = this.popNextN(msg, bodyLength);

        switch (packet["cType"]) {
            case contentType.HANDSHAKE:
                if (this._encrypted) {
                    bodyMsg = this._decryptMsg(packet, bodyMsg);
                }
                if (this._handshakeInProgress) {
                    this._handshakeMessages[bodyMsg[0]] = bodyMsg.slice(0, bodyLength);
                }

                packet["hType"] = arrayToUint(this.popNextN(bodyMsg, 1));
                handshakeBodyLength = arrayToUint(this.popNextN(bodyMsg, 3));
                packet["handshakeSeq"] = arrayToUint(this.popNextN(bodyMsg, 2));

                packet["fragmentOffset"] = arrayToUint(this.popNextN(bodyMsg, 3));
                packet["fragmentLength"] = arrayToUint(this.popNextN(bodyMsg, 3));

                handshakeBody = this.popNextN(bodyMsg, handshakeBodyLength);
                packet = Object.assign({}, packet, this._readHandshakePacket(handshakeBody, packet["hType"]));
                break;

            case contentType.CHANGE_CIPHER_SPEC:
                /* read 0x01 */
                if (arrayToUint(this.popNextN(bodyMsg, 1)) !== 0x01)
                    Utils.logError("Invalid ChangeCipherSpec DTLS message.");
                break;

            default:
                break;
        }

        Utils.logDebug("incomming packet " + JSON.stringify(packet));
        return packet;
    }

    _sendHandshakeFinished() {
        let responsePacket = {
            "cType": contentType.HANDSHAKE,
            "hType": handshakeType.FINISHED,
            "epoch": 1,
            "headerSeq": 0,
            "handshakeSeq":3
        };
        this._encrypted = true;
        this._handshakeInProgress = false;
        let msg = this._createPacket(responsePacket);
        this._sendMsg(msg);
    }

    _sendHandshakeCipherSpec() {
        let responsePacket = {
            "cType": contentType.CHANGE_CIPHER_SPEC,
            "epoch": 0,
            "headerSeq": 3,
            "handshakeSeq": 3
        };
        let msg = this._createPacket(responsePacket);
        this._sendMsg(msg, this._sendHandshakeFinished);
    }

    _sendKeyExchange() {
        let responsePacket = {
            "cType": contentType.HANDSHAKE,
            "hType": handshakeType.CLIENT_KEY_EXCHANGE,
            "epoch": 0,
            "headerSeq": 2,
            "handshakeSeq": 2,
            "psk": this._psk
        };
        let msg = this._createPacket(responsePacket);
        this._sendMsg(msg, this._sendHandshakeCipherSpec);
    }

    /**
     * Handles handshake message and sends response
     * 
     * @method _handleResponseHandshake
     * @param {Object} packet with data
     */
    _handleResponseHandshake(packet) {
        let msg = [];
        let responsePacket = [];

        switch(packet["hType"]) {
            case handshakeType.SERVER_HELLO:
                Utils.logDebug("Received server hello");
                break;

            case handshakeType.SERVER_HELLO_DONE:
                Utils.logDebug("Received server hello done");
                this._sendKeyExchange();
                break;

            case handshakeType.HELLO_VERIFY_REQUEST:
                Utils.logDebug("Received hello verify request");

                responsePacket = this._helloClientPacket;
                responsePacket["headerSeq"] = 1;
                responsePacket["handshakeSeq"] = 1;
                responsePacket["cookie"] = packet["cookie"];

                msg = this._createPacket(responsePacket);

                this._sendMsg(msg, null);
                break;

            case handshakeType.FINISHED:
                this._encrypted = true;
                this._handshakeInProgress = false;
                this.streamSeq = 0;
                Utils.logDebug("Received handshake finished");
                this.emit("connected");
                break;

            default:
                break;
        }
    }

    /**
     * Handles message
     * 
     * @method _handleResponse
     * @param {Object} packet with data
     */
    _handleResponse(packet) {

        switch(packet["cType"]) {
            case contentType.HANDSHAKE:
                this._handleResponseHandshake(packet);
                break;

            case contentType.CHANGE_CIPHER_SPEC:
                break;

            case contentType.ALERT:
                Utils.logDebug("Alert message type: " + packet["cType"]);
                this.closeBridge();
                break;

            default:
                Utils.logDebug("Unknown message type: " + packet["cType"]);
                break;
        }
        return;
    }

    /**
     * If debugging is enabled log the message in hex format
     * 
     * @method _loghex
     * @param {String} message to be printed
     * @param {String} array of bytes to be printed in hex format
     */
    _loghex(msg, a) {
        if (!Utils.getDebug()) {
            return;
        }

        let s = "";
        for (let i = 0 ; i < a.length; i++) {
            let bytestr = a[i].toString(16);
            if (bytestr.length === 1)
                s = s + "0";
            s=s + bytestr;
        }

        Utils.logDebug(`${msg} (${a.length}) ${s}`);
    }

    /**
     * If debugging is enabled data needed for decription of message
     * 
     * @method _logDecryptionData
     * @param {String} which credentials to use
     * @param {Object} packet belonging to the message
     * @param {String} array msg in bytes
     */
    _logDecryptionData(peer, packet, msg) {
        if (!Utils.getDebug()) {
            return;
        }

        this._loghex("msg for decryption: ", msg);

        if (peer == "server") {
            this._loghex("server write key: ", this._serverWriteKey);
        } else {
            this._loghex("server write key: ", this._clientWriteKey);
        }

        let epochAndSeq = msg.slice(0, 8);

        let tag;
        if (peer == "server") {
            tag = msg.slice(msg.length - this._serverWriteKey.length, msg.length);
        } else {
            tag = msg.slice(msg.length - this._clientWriteKey.length, msg.length);
        }

        this._loghex("tag: ", tag);

        let nonce;
        let encryptedMsg;
        if (peer == "server") {
            nonce = this._serverIV.concat(epochAndSeq);
            this._loghex("server nonce (IV): ", nonce);

            encryptedMsg = msg.slice(8, msg.length - this._serverWriteKey.length)
        } else {
            nonce = this._clientIV.concat(epochAndSeq);
            this._loghex("client nonce (IV): ", nonce);

            encryptedMsg = msg.slice(8, msg.length - this._clientWriteKey.length)
        }
        
        this._loghex("encrypted msg: ", encryptedMsg);

        let aad = epochAndSeq.slice();
        aad = aad.concat(uintToArray(packet["cType"], 8));
        aad = aad.concat(uintToArray(this._protocolVersion, 16));
        aad = aad.concat(uintToArray(encryptedMsg.length, 16));
        this._loghex("aad: ", aad);
    }

    /**
     * Encrypt message using client credentials and make
     * the message ready to send
     * 
     * @method _encryptMsg
     * @param {Object} packet belonging to the message
     * @param {Object} cleartext
     * @param {Object} packet belonging to the message
     * @return {Object} array with encrypted message
     */
    _encryptMsg(packet, msg) {
        let encryptedMsg = [];

        let epochAndSeq = uintToArray(packet["epoch"], 16);
        epochAndSeq = epochAndSeq.concat(uintToArray(packet["headerSeq"], 48));

        let nonce = this._clientIV.concat(epochAndSeq);

        let aad = epochAndSeq.slice();
        aad = aad.concat(uintToArray(packet["cType"], 8));
        aad = aad.concat(uintToArray(this._protocolVersion, 16));
        aad = aad.concat(uintToArray(msg.length, 16));

        try {
            let encrypted = gcm.authenticatedEncryption(msg, aad, nonce, this._clientWriteKey);

            encryptedMsg = encrypted.cipherText.concat(encrypted.authenticationTag);
        } catch (e) {
                Utils.logError("hue encryption error: " + e);
        }

        encryptedMsg = epochAndSeq.concat(encryptedMsg);

        return encryptedMsg;
    }

    _decryptMsg(packet, msg) {
        let decryptedMsg = [];
        let epochAndSeq = msg.slice(0, 8);
        let tag = msg.slice(msg.length - this._serverWriteKey.length, msg.length);
        let nonce = this._serverIV.concat(epochAndSeq);
        let encryptedMsg = msg.slice(8, msg.length - this._serverWriteKey.length)

        let aad = epochAndSeq.slice();
        aad = aad.concat(uintToArray(packet["cType"], 8));
        aad = aad.concat(uintToArray(this._protocolVersion, 16));
        aad = aad.concat(uintToArray(encryptedMsg.length, 16));

        decryptedMsg = gcm.authenticatedDecryption(
            encryptedMsg,
            aad,
            nonce,
            tag,
            this._serverWriteKey
        );


        return decryptedMsg;
    }

    /**
     * Encrypt and send DTLS aplication data message
     * 
     * @method sendEncrypted
     * @param {Object} cleartext
     * @return {Boolean} true if sent
     */
    sendEncrypted(cleartext) {
        this._readyToSend = false;

        if (this._encrypted === false) {
            return false;
        }

        this.streamSeq++;

        let packet = {
            "cType": contentType.APPLICATION_DATA,
            "epoch": 1,
            "headerSeq": this.streamSeq,
        };

        let encryptedMsg = this._encryptMsg(packet, cleartext);

        let msg = this._createRecordHeader(packet, encryptedMsg.length);

        msg = msg.concat(encryptedMsg);

        this._outputStream.write_all_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            this._ouputCancelleable,
            (o, res) => {
                this._outputStream.write_all_finish(res);
            }
        );
        return true;
    }

    clearTimers() {
        for (let t of this.timers) {
            if (t) {
                GLib.Source.remove(t);
            }
        }

        this.timers = [];
    }
})
