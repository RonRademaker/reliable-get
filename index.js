'use strict';

var request = require('request');
var sf = require('sf');
var url = require('url');
var util = require('util');
var _ = require('lodash');
var utils = require('./lib/utils');
var EventEmitter = require('events').EventEmitter;
var CacheFactory = require('./lib/cache/cacheFactory');
var statusCodeToErrorLevelMap = {'3': 'info', '4': 'warn', '5': 'error' };

function ReliableGet(config) {

    var cache = CacheFactory.getCache(config.cache);

    config = config || {};
    config.requestOpts = config.requestOpts || { agent: false };
    config.requestOpts.followRedirect = config.requestOpts.followRedirect !== false; // make falsey values true

    // Backwards compatibility
    if (config.followRedirect === false) {
        config.requestOpts.followRedirect = false;
    }

    var requestWithDefault = request.defaults(config.requestOpts);

    this.get = function(options, next) {

        var self = this,
            start = Date.now(),
            hasCacheControl = function(res, value) {
                return (res.headers['cache-control'] || '').indexOf(value) !== -1;
            };

        // Defaults
        options.headers = options.headers || config.headers || {};
        options.cacheKey = options.cacheKey || utils.urlToCacheKey(options.url);
        options.cacheTTL = options.hasOwnProperty('cacheTTL') ? options.cacheTTL : 60000;
        options.timeout = options.hasOwnProperty('timeout') ? options.timeout : 5000;

        var pipeAndCacheContent = function(cb) {

            var content = '', start = Date.now(), inErrorState = false, res;

            function handleError(err, statusCode, headers) {
                if (!inErrorState) {
                    inErrorState = true;
                    var message = sf('Service {url} responded with {errorMessage}', {
                        url: options.url,
                        errorMessage: err.message
                    });
                    var statusGroup = '' + Math.floor(statusCode / 100);
                    var errorLevel = statusCodeToErrorLevelMap[statusGroup] || 'error';
                    var errorMessage = (errorLevel === 'error' ? 'FAIL ' + message : message);
                    self.emit('log', errorLevel, errorMessage, {tracer:options.tracer, statusCode: statusCode, type:options.type});
                    self.emit('stat', 'increment', options.statsdKey + '.requestError');
                    cb({statusCode: statusCode || 500, message: message, headers: headers});
                }
            }

            if(!url.parse(options.url).protocol && options.url !== 'cache') { return handleError({message:'Invalid URL ' + options.url}); }

            options.headers.accept = options.headers.accept || 'text/html,application/xhtml+xml,application/xml,application/json';
            options.headers['user-agent'] = options.headers['user-agent'] || 'Reliable-Get-Request-Agent';

            requestWithDefault({ url: options.url, timeout: options.timeout, headers: options.headers })
                .on('error', handleError)
                .on('data', function(data) {
                    content += data.toString();
                })
                .on('response', function(response) {
                    res = response;
                    if(response.statusCode != 200) {
                        handleError({message:'status code ' + response.statusCode}, response.statusCode, response.headers);
                    }
                })
                .on('end', function() {
                    if(inErrorState) { return; }
                    res.content = content;
                    res.timing = Date.now() - start;
                    cb(null, res);
                    self.emit('log', 'debug', 'OK ' + options.url, {tracer:options.tracer, responseTime: res.timing, type:options.type});
                    self.emit('stat', 'timing', options.statsdKey + '.responseTime', res.timing);
                });

        }

        var getWithNoCache = function() {
            pipeAndCacheContent(function(err, res) {
                if(err) { return next(err); }
                res.headers = res.headers || {};
                if (!hasCacheControl(res, 'no-cache') || !hasCacheControl(res, 'no-store')) {
                    res.headers['cache-control'] = 'no-cache, no-store, must-revalidate';
                }
                next(null, {statusCode: res.statusCode, content: res.content, headers: res.headers, timing: res.timing});
            });
        }

        if(!options.explicitNoCache && options.cacheTTL > 0) {

            cache.get(options.cacheKey, function(err, cacheData, oldCacheData) {

                if (err) { return getWithNoCache(); }
                if (cacheData && cacheData.content) {
                    var timing = Date.now() - start;
                    self.emit('log','debug', 'CACHE HIT for key: ' + options.cacheKey,{tracer:options.tracer, responseTime: timing, type:options.type});
                    self.emit('stat', 'increment', options.statsdKey + '.cacheHit');
                    next(null, {statusCode: 200, content: cacheData.content, headers: cacheData.headers, timing: timing});
                    return;
                }

                self.emit('log', 'debug', 'CACHE MISS for key: ' + options.cacheKey,{tracer:options.tracer, type:options.type});
                self.emit('stat', 'increment', options.statsdKey + '.cacheMiss');

                if(options.url == 'cache') {
                    next(null, {content: 'No content in cache at key: ' + options.cacheKey, statusCode: 404});
                    return;
                }

                pipeAndCacheContent(function(err, res) {

                    if (err) {
                        var staleContent = oldCacheData ? _.extend(oldCacheData, {stale: true}) : undefined;
                        if (oldCacheData) {
                            self.emit('log', 'debug', 'Serving stale cache for key: ' + options.cacheKey, {tracer: options.tracer, type: options.type});
                            self.emit('stat', 'increment', options.statsdKey + '.cacheStale');
                        } else {
                            if(cache.engine !== 'nocache') {
                                self.emit('log', 'warn', 'Error and no stale cache available for key: ' + options.cacheKey, {tracer: options.tracer, type: options.type});
                                self.emit('stat', 'increment', options.statsdKey + '.cacheNoStale');
                            }
                        }
                        return next(err, staleContent);
                    }

                    if (hasCacheControl(res, 'no-cache') || hasCacheControl(res, 'no-store')) {
                        next(null, {statusCode: 200, content: res.content, headers: res.headers});
                        return;
                    }
                    if (hasCacheControl(res, 'max-age')) {
                        options.cacheTTL = res.headers['cache-control'].split('=')[1] * 1000;
                    }

                    cache.set(options.cacheKey, {content: res.content, headers: res.headers, options: options}, options.cacheTTL, function() {
                        next(null, {statusCode: 200, content: res.content, headers:res.headers, timing: res.timing});
                        self.emit('log','debug', 'CACHE SET for key: ' + options.cacheKey + ' @ TTL: ' + options.cacheTTL,{tracer:options.tracer,type:options.type});
                    });

                });

            });

        } else {

            getWithNoCache();

        }

    }

    this.disconnect = function() {
        if(cache.disconnect) { cache.disconnect(); }
    }

}

util.inherits(ReliableGet, EventEmitter);

module.exports = ReliableGet;
