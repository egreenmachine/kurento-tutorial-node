/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var kurento = require('kurento-client');
var express = require('express');
var app = express();
var path = require('path');
var wsm = require('ws');
var session = require('express-session');
var environment = require('sip.js/src/environment');
environment.WebSocket = wsm;
environment.Promise = require('q');
var SIP = require('sip.js/src/SIP')(environment);

var KurentoMediaHandler = function(session, options) {
  var events = [
  ];
  options = options || {};

  this.logger = session.ua.getLogger('sip.invitecontext.mediahandler', session.id);
  this.session = session;
  this.ready = true;
  this.audioMuted = false;
  this.videoMuted = false;
  
  this.selfSdp = null;

  // old init() from here on
  var idx, length, server,
    servers = [],
    stunServers = options.stunServers || null,
    turnServers = options.turnServers || null,
    config = this.session.ua.configuration;
  this.RTCConstraints = options.RTCConstraints || {};

  if (!stunServers) {
    stunServers = config.stunServers;
  }

  if(!turnServers) {
    turnServers = config.turnServers;
  }

  /* Change 'url' to 'urls' whenever this issue is solved:
   * https://code.google.com/p/webrtc/issues/detail?id=2096
   */
  servers.push({'url': stunServers});

  length = turnServers.length;
  for (idx = 0; idx < length; idx++) {
    server = turnServers[idx];
    servers.push({
      'url': server.urls,
      'username': server.username,
      'credential': server.password
    });
  }

  this.initEvents(events);
}

KurentoMediaHandler.prototype = Object.create(SIP.MediaHandler.prototype, {
  render: {writable: true, value: function render () {
    //This will run on node so nothing will be rendered.
  }},
  
  isReady: {writable: true, value: function isReady () {
    // I was born ready.
    return true;
  }},
  
  close: {writable: true, value: function close () {
    // TODO: THIS
  }},
  
  getDescription: {writable: true, value: function getDescription (onSuccess, onFailure, mediaHint) {
    // TODO: THIS
    /* This will have to retrieve the SDP generated by setting up the kurento media
     * server in setDescription. 
     */
    
    return SIP.Utils.Promise.resolve(this.selfSdp);
  }},
  
  setDescription: {writable: true, value: function setDescription (sdp, onSuccess, onFailure) {
    /* This will need to take the remote description and setup the kurento media
     * server. It will always be called before getDescription. The result sdp from 
     * setting up the Kurento media server can be stored in some global to be
     * accessed later.
     */
     var self = this;
     var deferred = SIP.Utils.Promise.defer();
     start('aaaaaaaaa', sdp, function(error, sdpAnswer) {
				if (error) {
					console.log("ERROR");
					return SIP.Utils.Promise.reject();
				}
				self.selfSdp = sdpAnswer;
				return deferred.resolve();
			});
      return deferred.promise;
  }},
  
  mute: {writable: true, value: function mute (options) {
    // Does your mother implement this? Neither do I
  }},
  
  unmute: {writable: true, value: function unmute (options) {
    // Cannot unmute something that cannot be muted
  }},
  
});

var kurentoMediaHandlerFactory = function (session, options) {
  return new KurentoMediaHandler(session, options);
};

var ua = new SIP.UA({
        uri: 'node@devgreen1.onsip.com',
        traceSip: true,
        mediaHandlerFactory: kurentoMediaHandlerFactory 
    });

ua.on('invite', function(session) {
  console.log('invite received');
  session.accept();
});

/*
 * Management of sessions
 */
app.use(express.cookieParser());

var sessionHandler = session({
	secret : 'none',
	rolling : true,
	resave : true,
	saveUninitialized : true
});

app.use(sessionHandler);

app.set('port', process.env.PORT || 8080);

/*
 * Defintion of constants
 */

const
ws_uri = "ws://localhost:8888/kurento";

/*
 * Definition of global variables.
 */

var pipelines = {};
var kurentoClient = null;

/*
 * Server startup
 */

var port = app.get('port');
var server = app.listen(port, function() {
	console.log('Express server started ');
	console.log('Connect to http://<host_name>:' + port + '/');
});

var WebSocketServer = wsm.Server, wss = new WebSocketServer({
	server : server,
	path : '/magicmirror'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
	var sessionId = null;
	var request = ws.upgradeReq;
	var response = {
		writeHead : {}
	}; // black magic here

	sessionHandler(request, response, function(err) {
		sessionId = request.session.id;
		console.log("Connection received with sessionId " + sessionId);
	});

	ws.on('error', function(error) {
		console.log('Connection ' + sessionId + ' error');
		stop(sessionId);
	});

	ws.on('close', function() {
		console.log('Connection ' + sessionId + ' closed');
		stop(sessionId);
	});

	ws.on('message', function(_message) {
		var message = JSON.parse(_message);
		console.log('Connection ' + sessionId + ' received message ', message);

		switch (message.id) {
		case 'start':
			start(sessionId, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'error',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'startResponse',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

		case 'stop':
			stop(sessionId);
			break;

		default:
			ws.send(JSON.stringify({
				id : 'error',
				message : 'Invalid message ' + message
			}));
			break;
		}

	});
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
	if (kurentoClient !== null) {
		return callback(null, kurentoClient);
	}

	kurento(ws_uri, function(error, _kurentoClient) {
		if (error) {
			console.log("Could not find media server at address " + ws_uri);
			return callback("Could not find media server at address" + ws_uri
					+ ". Exiting with error " + error);
		}

		kurentoClient = _kurentoClient;
		callback(null, kurentoClient);
	});
}

function start(sessionId, sdpOffer, callback) {

	if (!sessionId) {
		return callback("Cannot use undefined sessionId");
	}

	// Check if session is already transmitting
	if (pipelines[sessionId]) {
		return callback("You already have an magic mirror with this session. Close current session before starting a new one or use another browser to open a new magic mirror.")
	}

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			return callback(error);
		}

		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				return callback(error);
			}

			createMediaElements(pipeline, function(error, webRtcEndpoint,
					player) {
				if (error) {
					pipeline.release();
					return callback(error);
				}

				connectMediaElements(webRtcEndpoint, player,
						function(error) {
							if (error) {
								pipeline.release();
								return callback(error);
							}

							webRtcEndpoint.processOffer(sdpOffer, function(
									error, sdpAnswer) {
								if (error) {
									pipeline.release();
									return callback(error);
								}
                player.play();
								pipelines[sessionId] = pipeline;
								return callback(null, sdpAnswer);
							});
						});
			});
		});
	});
}

function createMediaElements(pipeline, callback) {

	pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			return callback(error);
		}
		
		pipeline.create('PlayerEndpoint', {uri:"http://files.kurento.org/video/60sec/ball.webm"}, function(error,player) {
  		if (error) {
    		return callback(error);
  		}
  		
  		return callback(null, webRtcEndpoint,player);
		});

		/*
pipeline.create('FaceOverlayFilter',
				function(error, faceOverlayFilter) {
					if (error) {
						return callback(error);
					}

					faceOverlayFilter.setOverlayedImage(
							"http://files.kurento.org/imgs/mario-wings.png",
							-0.35, -1.2, 1.6, 1.6, function(error) {
								if (error) {
									return callback(error);
								}

								return callback(null, webRtcEndpoint,
										faceOverlayFilter);

							});
				});
*/
    
	});
}

function connectMediaElements(webRtcEndpoint, player, callback) {
	webRtcEndpoint.connect(player, function(error) {
		if (error) {
			return callback(error);
		}

		player.connect(webRtcEndpoint, function(error) {
			if (error) {
				return callback(error);
			}

			return callback(null);
		});
	});
}

function stop(sessionId) {
	if (pipelines[sessionId]) {
		var pipeline = pipelines[sessionId];
		pipeline.release();
		delete pipelines[sessionId];
	}
}

app.use(express.static(path.join(__dirname, 'static')));
