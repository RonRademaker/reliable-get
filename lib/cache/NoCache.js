'use strict';

var EventEmitter = require('events').EventEmitter;


function NoCache() {

    this.engine = 'nocache';

    this.get = function(key, next) {
        if(key === '__error__') { return next({message:'Error test'}); }
        next(null, null);
    };

    this.set = function(key, value, ttl, next) {
        if(next) { next(null, null); }
    };

    this.emit('ready');
}

module.exports = NoCache;

require('util').inherits(NoCache, EventEmitter);
