/* License: See the COPYING file in this distribution.
 *
 * Copyright (c) 2010 Terry Riegel <riegel@clearimageonline.com>
 * Copyright (c) 2011 Aria Stewart <aredridel@nbtsc.org>
 */

var net = require('net');
var stream = require('stream')
var util = require('util');

var left = function (str, n) {
	if (n <= 0) {return "";}
	if (n > String(str).length) {return this;}
	return String(str).substring(0,n);
}

function MessageStream() {
	stream.Stream.call(this)
	this.hasErred = false
	this.started = false
}
util.inherits(MessageStream, stream.Stream)

exports.MessageStream = MessageStream

MessageStream.prototype.pause = function() { this.emit('pause') }
MessageStream.prototype.resume = function() { this.emit('resume') }

MessageStream.prototype.accept = function() { 
	this.smtpCode = 250
	this.smtpMessage = 'Message Accepted'
	this.emit('accept', this.smtpCode, this.smtpMessage)
}
MessageStream.prototype.reject = function(m) { 
	this.smtpCode = 551
	this.smtpMessage = m ? m : 'Message Rejected'
	this.emit('reject')
}
MessageStream.prototype.abort = function() {
	this.smtpCode = 421
	this.smtpMessage = 'Something went wrong'
	this.hasErred = true
}
MessageStream.prototype.start = function() {
	this.emit('start')
	this.started = true
}

var debug;
var debugLevel = parseInt(process.env.NODE_DEBUG, 16);
if (debugLevel & 0x4) {
	debug = function (x) { util.error('SMTP: ' + x); };
} else {
	debug = function () { };
}

function lineBuffer(socket) {
	var buffer = ''
	var paused = false
	socket.on('pause', function() { 
		paused = true
	})
	socket.on('resume', function() {
		paused = false
		unspool()
	})
	var unspool = function unspool() {
		var i
		while(!paused && (i = buffer.indexOf("\n")) != -1) {
			socket.emit('line', buffer.slice(0, i + 1))
			buffer = buffer.slice(i + 1)
		}
	}
	socket.on('data', function(data) {
		buffer += data
		unspool()
	})
}

function Server(clientListener) {
	net.Server.call(this);
	this.allowPipelining = true
	this.hostname = 'hostname.unconfigured'
	this.on('connection', connectionListener);
	if(clientListener) this.on('connection', clientListener);
}
util.inherits(Server, net.Server);

exports.Server = Server;

exports.createServer = function(clientListener) {
	return new Server(clientListener);
}

function connectionListener(socket) {
	lineBuffer(socket)

	debug("new smtp connection");

	socket.setTimeout(2*60*1000); // 2 minute timeout

	socket.on('timeout', function () {
		socket.destroy();
	});

	socket.setEncoding('utf8');

	socket.out = function(a){
		try {
			socket.write(a+'\r\n')
		} catch(e) {
			socket.emit('error', e)
		}
	}

	socket.on('connect', function () {
		socket.out('220 ' + this.hostname + ' ESMTP node.js');
		socket.state = 'welcome';
		resetSMTPState(socket)
	}.bind(this));

	socket.on('line', function (line) {
		if (socket.state == 'data') {
			var message = socket.currentMessage
			if(line.match(/^\./)) {
				message.emit('end')
				socket.state = 'welcome'
				var f = function() { acceptOrReject(socket, message) }
				if(typeof(message.smtpCode) == 'undefined') {
					message.pause()
					message.on('accept', f)
					message.on('reject', f)
					message.on('error', f)
				} else {
					acceptOrReject(socket, message)
				}
			} else {
				message.emit('data', line)
			}
		} else {
			var m
			line = line.trimRight()
			if(m = line.match(/^(HELO|EHLO)\s+(.*)/i)) {
				var helodata = {name: m[2], valid: true, extended: m[1].toUpperCase() == 'EHLO' }
				socket.emit(m[1], helodata)
				if(helodata.valid) {
					socket.helo = helodata
					if(helodata.extended) {
						socket.out('250-' + this.hostname)
						if(socket.maxSize) socket.out("250-SIZE " + socket.maxsize)
						if(socket.allowPipelining) socket.out("250-PIPELINING")
						if(socket.authMethods) socket.out("250-AUTH "+socket.authMethods.join(' '))
						socket.out('250 HELP')
					} else {
						socket.out('250 ' + this.hostname)
					}
				} else {
					socket.out('550 Bad argument to HELO')
				}
			} else if(m = line.match(/^MAIL FROM:\s*(.*)\s*/i)) {
				if(socket.sender) socket.out("503 We already got one, you see.")
				var sender = {address: m[1], valid: true}
				socket.emit('MAIL FROM', sender)
				if(sender.valid) {
					socket.sender = sender
					socket.out("250 MAIL FROM looks good enough for me.")
				} else {
					socket.out("550 Go Away, you silly English Knnnniiight")
				}
			} else if(m = line.match(/^RCPT TO:\s*(.*)\s*/i)) {
				var recip = {address: m[1], valid: true}
				socket.emit('RCPT TO', recip)
				if(recip.valid) {
					socket.recipients.push(recip)
					socket.out("250 RCPT TO ...I hope that's right. I didn't check.)")
				} else {
					socket.out("550 We found a witch! May we burn her?")
				}
			} else if(line.match(/^DATA\b/i)) {
				socket.state = 'data';
				try {
					var message = new MessageStream()
					socket.currentMessage = message
					message.recipients = socket.recipients
					message.sender = socket.sender
					message.connection = socket
					message.on('pause', function() {
						socket.pause()
					})
					message.on('resume', function() {
						try {
							socket.resume()
						} catch(e) {
							// ignore: Probably already closed the socket.
						}
					})
					message.on('error', function(e) {
						message.error = e
						if(!message.started) {
							socket.out((e.smtpCode ? e.smtpCode : '451') + (e.smtpMessage ? ' ' + e.smtpMessage : ' Well, that could have gone better.'));
							socket.state = 'welcome'
						}
					})
					socket.emit('DATA', socket.currentMessage)
					socket.out('354 Enter mail, end with "." on a line by itself');
					if(message.hasErred) {	
						acceptOrReject(socket, message)
						socket.state = 'welcome'
					}
				} catch(e) {
					socket.out('451 Internal Error')
					socket.state = 'welcome'
				}
			} else if(line.match(/^NOOP\b/i)) {
				socket.out('250 OK');
			} else if(line.match(/^QUIT\b/i)) {
				socket.emit('QUIT')
				socket.out('221 Go away, you silly English pig-dog types');
				socket.destroy()
			} else if(line.match(/^RSET\b/i)) {
				socket.emit('RSET')
				resetSMTPState(socket)
				socket.out('250 Reset OK');
			} else if(line.match(/^HELP\b/i)) {
				socket.out('214-Commands supported\r\n214 HELO MAIL RCPT DATA\r\n214 NOOP QUIT RSET HELP');
			} else if(line.match(/^EXPN\b/i)) {
				socket.emit('EXPN')
				socket.out('550 EXPN not available');
			} else if(line.match(/^(EHLO|SEND|SAML|SOML|TURN)\b/i)) {
				socket.out('502 Unsupported here');
			} else if(line.match(/^VRFY\b/i)) {
				socket.out('252 VRFY not available');
			} else {
				socket.out('500 Unrecognized command');
			}
		}
	}.bind(this));
	socket.on('end', function () {
		socket.destroy();
	});
}

function resetSMTPState(socket) {
	socket.recipients = []
	socket.sender = null
	socket.currentMessage = null
	socket.heloname = null
}

function acceptOrReject(socket, message) {
	if(message.smtpCode >= 200 && message.smtpCode < 300) {
		socket.out(message.smtpCode + " " + message.smtpMessage)
	} else if(message.smtpCode >= 500 && message.smtpCode < 600) {
		socket.out(message.smtpCode + " " + message.smtpMessage)
	} else {
		socket.out("451 Something went wrong")
	}
	try {
		socket.resume()
	} catch(e) {
		// Socket probably closed already.
	}
}
