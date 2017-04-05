(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (process){
(() => {
  'use strict';

  const CircuitBreaker = require('./lib/circuit');
  const Fidelity = require('fidelity');

  const defaults = {
    timeout: 10000, // 10 seconds
    maxFailures: 10,
    resetTimeout: 30000, // 30 seconds
    Promise: Fidelity
  };

  /**
   * @module opossum
   */

  /**
   * Creates a {@link CircuitBreaker} instance capable of executing `action`.
   * @param action {function} The action to fire for this {@link CircuitBreaker} instance
   * @param options {Object} Options for the {@link CircuitBreaker}
   * @param options.timeout {number} The time in milliseconds that action should
   * be allowed to execute before timing out. Default 10000 (10 seconds)
   * @param options.maxFailures The number of times the circuit can fail before
   * opening. Default 10.
   * @param options.resetTimeout The time in milliseconds to wait before setting
   * the breaker to `halfOpen` state, and trying the action again.
   * @param options.Promise {Promise} Opossum uses Fidelity promises, but works
   * fine with any Promise that follows the spec. You can specify your favored
   * implementation by providing the constructor as an option.
   * @return a {@link CircuitBreaker} instance
   */
  function circuitBreaker (action, options) {
    return new CircuitBreaker(action, Object.assign({}, defaults, options));
  }

  /**
   * Given a function that receives a callback as its last argument,
   * and which executes that function, passing as parameters `err` and `result`,
   * creates an action that returns a promise which resolves when the function's
   * callback is executed.
   * @function promisify
   *
   * @param action {function} A Node.js-like asynchronous function
   * @return The `action` wrapped in a promise API.
   * @example
   *     const fs = require('fs');
   *     const readFilePromised = circuitBreaker.promisify(fs.readFile);
   *     const breaker = circuitBreaker(readFilePromised);
   */
  circuitBreaker.promisify = require('./lib/promisify');

  if (typeof window === 'object') {
    window[circuitBreaker.name] = circuitBreaker;
  }
  if (typeof process === 'object') {
    // we're in a node.js environment
    module.exports = exports = circuitBreaker;
  }
}).call();

}).call(this,require('_process'))
},{"./lib/circuit":2,"./lib/promisify":4,"_process":8,"fidelity":7}],2:[function(require,module,exports){
'use strict';

const EventEmitter = require('events');
const Status = require('./status');

const STATE = Symbol('state');
const OPEN = Symbol('open');
const CLOSED = Symbol('closed');
const HALF_OPEN = Symbol('half-open');
const PENDING_CLOSE = Symbol('pending-close');
const FALLBACK_FUNCTION = Symbol('fallback');
const NUM_FAILURES = Symbol('num-failures');
const STATUS = Symbol('status');
const NAME = Symbol('name');
const CACHE = new WeakMap();

/**
 * @class CircuitBreaker
 * @extends EventEmitter
 * Constructs a {@link CircuitBreaker}.
 * @param action {function} The action to fire for this {@link CircuitBreaker} instance
 * @param options {Object} Options for the {@link CircuitBreaker}.
 * There are **no default options** when you use the contructor directly. You
 * must supply values for each of these.
 * @param options.timeout {number} The time in milliseconds that action should
 * be allowed to execute before timing out.
 * @param options.maxFailures The number of times the circuit can fail before
 * opening.
 * @param options.resetTimeout The time in milliseconds to wait before setting
 * the breaker to `halfOpen` state, and trying the action again.
 * @param options.rollingCountTimeout Sets the duration of the statistical
 *  rolling window, in milliseconds. This is how long Opossum keeps metrics for
 *  the circuit breaker to use and for publishing. Default: 10000
 * @param options.rollingCountBuckets sets the number of buckets the rolling
 *  statistical window is divided into. So, if options.rollingCountTimeout is
 *  10000, and options.rollingCountBuckets is 10, then the statistical window
 *  will be 1000 1 second snapshots in the statistical window. Default: 10
 * @fires CircuitBreaker#halfOpen
 */
class CircuitBreaker extends EventEmitter {
  constructor (action, options) {
    super();
    this.options = options;
    this.options.rollingCountTimeout = options.rollingCountTimeout || 10000;
    this.options.rollingCountBuckets = options.rollingCountBuckets || 10;
    this.Promise = options.Promise;
    this[STATUS] = new Status(this);
    this[STATE] = CLOSED;
    this[FALLBACK_FUNCTION] = null;
    this[PENDING_CLOSE] = false;
    this[NUM_FAILURES] = 0;
    this[NAME] = options.name || action.name || nextName();

    if (typeof action !== 'function') this.action = () => this.Promise.resolve(action);
    else this.action = action;

    /**
     * Emitted after `options.resetTimeout` has elapsed, allowing for
     * a single attempt to call the service again. If that attempt is
     * successful, the circuit will be closed. Otherwise it remains open.
     * @event CircuitBreaker#halfOpen
     */
    function _startTimer (circuit) {
      return () => {
        const timer = setTimeout(() => {
          circuit[STATE] = HALF_OPEN;
          circuit.emit('halfOpen', circuit.options.resetTimeout);
        }, circuit.options.resetTimeout);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      };
    }

    this.on('open', _startTimer(this));
    this.on('success', () => this.close());
    if (this.options.cache) {
      CACHE.set(this, undefined);
    }
  }

  /**
   * Closes the breaker, allowing the action to execute again
   * @fires CircuitBreaker#close
   */
  close () {
    this[NUM_FAILURES] = 0;
    this[PENDING_CLOSE] = false;
    if (this[STATE] !== CLOSED) {
      this[STATE] = CLOSED;
      /**
       * Emitted when the breaker is reset allowing the action to execute again
       * @event CircuitBreaker#close
       */
      this.emit('close');
    }
  }

  /**
   * Opens the breaker. Each time the breaker is fired while the circuit is
   * opened, a failed Promise is returned, and any fallback function
   * that has been provided is invoked.
   * @fires CircuitBreaker#open
   */
  open () {
    this[PENDING_CLOSE] = false;
    if (this[STATE] !== OPEN) {
      this[STATE] = OPEN;
      /**
       * Emitted when the breaker opens because the action has
       * failed more than `options.maxFailures` number of times.
       * @event CircuitBreaker#open
       */
      this.emit('open');
    }
  }

  get name () {
    return this[NAME];
  }

  /**
   * True if the circuit is currently closed. False otherwise.
   */
  get closed () {
    return this[STATE] === CLOSED;
  }

  /**
   * True if the circuit is currently opened. False otherwise.
   */
  get opened () {
    return this[STATE] === OPEN;
  }

  /**
   * True if the circuit is currently half opened. False otherwise.
   */
  get halfOpen () {
    return this[STATE] === HALF_OPEN;
  }

  /**
   * The current {@link Status} of this {@link CircuitBreaker}
   */
  get status () {
    return this[STATUS];
  }

  /**
   * Provide a fallback function for this {@link CircuitBreaker}. This
   * function will be executed when the circuit is `fire`d and fails.
   * It will always be preceded by a `failure` event, and `breaker.fire` returns
   * a rejected Promise.
   * @param func {Function | CircuitBreaker} the fallback function to execute when the breaker
   * has opened or when a timeout or error occurs.
   * @return {@link CircuitBreaker} this
   */
  fallback (func) {
    let fb = func;
    if (func instanceof CircuitBreaker) {
      fb = function () {
        return func.fire.apply(func, arguments);
      };
    }
    this[FALLBACK_FUNCTION] = fb;
    return this;
  }

  /**
   * Execute the action for this circuit. If the action fails or times out, the
   * returned promise will be rejected. If the action succeeds, the promise will
   * resolve with the resolved value from action. If a fallback function has been
   * provided, it will be invoked in the event of any failure or timeout.
   *
   * @return {@link Promise} a Promise that resolves on success and is rejected
   * on failure of the action.
   *
   * @fires CircuitBreaker#failure
   * @fires CircuitBreaker#fallback
   * @fires CircuitBreaker#fire
   * @fires CircuitBreaker#reject
   * @fires CircuitBreaker#success
   * @fires CircuitBreaker#timeout
   */
  fire () {
    const args = Array.prototype.slice.call(arguments);

    /**
     * Emitted when the circuit breaker action is executed
     * @event CircuitBreaker#fire
     */
    this.emit('fire', args);

    if (CACHE.get(this) !== undefined) {
      /**
       * Emitted when the circuit breaker is using the cache
       * and finds a value.
       * @event CircuitBreaker#cacheHit
       */
      this.emit('cacheHit');
      return CACHE.get(this);
    } else if (this.options.cache) {
      /**
       * Emitted when the circuit breaker does not find a value in
       * the cache, but the cache option is enabled.
       * @event CircuitBreaker#cacheMiss
       */
      this.emit('cacheMiss');
    }

    if (this.opened || (this.halfOpen && this[PENDING_CLOSE])) {
      /**
       * Emitted when the circuit breaker is open and failing fast
       * @event CircuitBreaker#reject
       */
      this.emit('reject', new Error('Breaker is open'));
      const failure = fail(this, 'Breaker is open', args);
      return fallback(this, 'Breaker is open', args) || failure;
    }
    this[PENDING_CLOSE] = this.halfOpen;

    let timeout;
    let timeoutError = false;
    return new this.Promise((resolve, reject) => {
      timeout = setTimeout(
        () => {
          timeoutError = true;
          const error = new Error(`Timed out after ${this.options.timeout}ms`);
          /**
           * Emitted when the circuit breaker action takes longer than `options.timeout`
           * @event CircuitBreaker#timeout
           */
          this.emit('timeout', error);
          resolve(fallback(this, error, args) || fail(this, error, args));
        }, this.options.timeout);

      try {
        const result = this.action.apply(this.action, args);
        const promise = (typeof result.then === 'function')
          ? result
          : this.Promise.resolve(result);

        promise
          .then((result) => {
            if (!timeoutError) {
              /**
               * Emitted when the circuit breaker action succeeds
               * @event CircuitBreaker#success
               */
              this.emit('success', result);
              resolve(result);
              if (this.options.cache) {
                CACHE.set(this, promise);
              }
              clearTimeout(timeout);
            }
          })
          .catch((error) =>
            handleError(error, this, timeout, args, resolve, reject));
      } catch (error) {
        handleError(error, this, timeout, args, resolve, reject);
      }
    });
  }

  /**
   * Clears the cache of this {@link CircuitBreaker}
   */
  clearCache () {
    CACHE.set(this, undefined);
  }
}

function handleError (error, circuit, timeout, args, resolve, reject) {
  clearTimeout(timeout);
  fail(circuit, error, args);
  const fb = fallback(circuit, error, args);
  if (fb) resolve(fb);
  else reject(error);
}

function fallback (circuit, err, args) {
  if (circuit[FALLBACK_FUNCTION]) {
    return new circuit.Promise((resolve, reject) => {
      const result = circuit[FALLBACK_FUNCTION].apply(circuit[FALLBACK_FUNCTION], args);
      /**
       * Emitted when the circuit breaker executes a fallback function
       * @event CircuitBreaker#fallback
       */
      circuit.emit('fallback', result, err);
      resolve(result);
    });
  }
}

function fail (circuit, err, args) {
  /**
   * Emitted when the circuit breaker action fails,
   * or when the circuit is fired while open.
   * @event CircuitBreaker#failure
   */
  circuit.emit('failure', err);
  circuit[NUM_FAILURES] += 1;

  if (circuit[NUM_FAILURES] >= circuit.options.maxFailures) {
    circuit.open();
  }
  return circuit.Promise.reject.apply(null, [err]);
}

// http://stackoverflow.com/a/2117523
const nextName = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });

module.exports = exports = CircuitBreaker;

},{"./status":5,"events":6}],3:[function(require,module,exports){
'use strict';

function getStreamData (circuit, name, group) {
  console.log(circuit.status, circuit.opened, circuit.halfOpen, circuit.closed);
  const json = {};
  json.type = 'HystrixCommand';
  json.name = name;
  json.group = group;
  json.currentTime = new Date();
  json.isCircuitBreakerOpen = circuit.opened || circuit.halfOpen;
  json.errorPercentage = circuit.status.fires === 0 ? 0 : (circuit.status.failures / circuit.status.fires) * 100;
  json.errorCount = circuit.status.failures;
  json.requestCount = circuit.status.fires;
  json.rollingCountBadRequests = circuit.status.failures;
  json.rollingCountCollapsedRequests = 0;
  json.rollingCountEmit = 0;
  json.rollingCountExceptionsThrown = 0;
  json.rollingCountFailure = circuit.status.failures;
  json.rollingCountFallbackEmit = circuit.status.fallbacks;
  json.rollingCountFallbackFailure = 0;
  json.rollingCountFallbackMissing = 0;
  json.rollingCountFallbackRejection = 0;
  json.rollingCountFallbackSuccess = 0;
  json.rollingCountResponsesFromCache = 0;
  json.rollingCountSemaphoreRejected = circuit.status.rejects;
  json.rollingCountShortCircuited = circuit.status.rejects;
  json.rollingCountSuccess = circuit.status.successes;
  json.rollingCountThreadPoolRejected = 0;
  json.rollingCountTimeout = circuit.status.timeouts;
  json.currentConcurrentExecutionCount = 0;
  json.rollingMaxConcurrentExecutionCount = 0;
  json.latencyExecute_mean = 0;
  json.latencyExecute = {
    '0': 0,
    '25': 0,
    '50': 0,
    '75': 0,
    '90': 0,
    '95': 0,
    '99': 0,
    '99.5': 0,
    '100': 0
  };
  json.latencyTotal_mean = 0;
  json.latencyTotal = { '0': 0, '25': 0, '50': 0, '75': 0, '90': 0, '95': 0, '99': 0, '99.5': 0, '100': 0 };
  json.propertyValue_circuitBreakerRequestVolumeThreshold = 5;
  json.propertyValue_circuitBreakerSleepWindowInMilliseconds = 5000;
  json.propertyValue_circuitBreakerErrorThresholdPercentage = 50;
  json.propertyValue_circuitBreakerForceOpen = false;
  json.propertyValue_circuitBreakerForceClosed = false;
  json.propertyValue_circuitBreakerEnabled = true;
  json.propertyValue_executionIsolationStrategy = 'THREAD';
  json.propertyValue_executionIsolationThreadTimeoutInMilliseconds = 300;
  json.propertyValue_executionTimeoutInMilliseconds = 300;
  json.propertyValue_executionIsolationThreadInterruptOnTimeout = true;
  json.propertyValue_executionIsolationThreadPoolKeyOverride = null;
  json.propertyValue_executionIsolationSemaphoreMaxConcurrentRequests = 10;
  json.propertyValue_fallbackIsolationSemaphoreMaxConcurrentRequests = 10;
  json.propertyValue_metricsRollingStatisticalWindowInMilliseconds = 10000;
  json.propertyValue_requestCacheEnabled = true;
  json.propertyValue_requestLogEnabled = true;
  json.reportingHosts = 1;

  return JSON.stringify(json);
}

module.exports = exports = {
  getStreamData
};

},{}],4:[function(require,module,exports){
'use strict';

const Fidelity = require('fidelity');

module.exports = exports = function promisify (func) {
  return function promisifiedFunction () {
    return new Fidelity((resolve, reject) => {
      const cb = (err, result) => {
        if (err) reject(err);
        resolve(result);
      };
      const args = Array.prototype.slice.call(arguments);
      args.push(cb);
      func.apply(func, args);
    });
  };
};

},{"fidelity":7}],5:[function(require,module,exports){
'use strict';

const CIRCUIT_BREAKER = Symbol('circuit-breaker');
const CIRCUIT_OPEN = Symbol('circuit-open');
const STATS_WINDOW = Symbol('stats-window');
const LISTENERS = Symbol('listeners');
const FIRES = Symbol('fires');
const FAILS = Symbol('fails');

/**
 * @class
 * Tracks execution status for a given {@link CircuitBreaker}
 * @param {CircuitBreaker} circuit the {@link CircuitBreaker} to track status for
 */
class Status {
  constructor (circuit) {
    this[LISTENERS] = new Set();
    this[CIRCUIT_BREAKER] = circuit;
    this[STATS_WINDOW] = [];
    this[FIRES] = 0;
    this[FAILS] = 0;
    this[CIRCUIT_OPEN] = false;

    // Keep total numbers for fires/failures
    circuit.on('fire', () => this[FIRES]++);
    circuit.on('failure', () => this[FAILS]++);

    // Keep track of circuit open state
    circuit.on('open', () => {
      this[CIRCUIT_OPEN] = true;
      this[STATS_WINDOW].isCircuitBreakerOpen = true;
      // console.error('circuit on open', circuit.status.window);
    });
    circuit.on('close', () => {
      this[CIRCUIT_OPEN] = false;
      this[STATS_WINDOW].isCircuitBreakerOpen = false;
    });

    circuit.on('success', increment(this, 'successes'));
    circuit.on('failure', increment(this, 'failures'));
    circuit.on('fallback', increment(this, 'fallbacks'));
    circuit.on('timeout', increment(this, 'timeouts'));
    circuit.on('fire', increment(this, 'fires'));
    circuit.on('reject', increment(this, 'rejects'));
    circuit.on('cacheHit', increment(this, 'cacheHits'));
    circuit.on('cacheMiss', increment(this, 'cacheMisses'));

    // Set up our statistical rolling window
    const buckets = circuit.options.rollingCountBuckets;
    const timeout = circuit.options.rollingCountTimeout;

    // Add the first bucket to the window
    this[STATS_WINDOW].unshift(stats());

    // TODO: do we guard against divide by zero, and for
    // greater accuracy, do we require that timeout be
    // evenly divisible by the number of buckets?
    const bucketInterval = Math.floor(timeout / buckets);
    const interval = setInterval(() => {
      const window = this[STATS_WINDOW];
      if (window.length === buckets) {
        window.pop();
      }
      let next = stats();
      next.isCircuitBreakerOpen = this[CIRCUIT_OPEN];
      window.unshift(next);
      for (const listener of this[LISTENERS]) {
        listener.call(listener, window[1]);
      }
    }, bucketInterval);
    if (typeof interval.unref === 'function') interval.unref();
  }

  /**
   * Add a status listener which will be called with the most
   * recently completed snapshot each time a new one is created.
   * @param {any} listener
   */
  addSnapshotListener (listener) {
    this[LISTENERS].add(listener);
  }

  /**
   * Gets the full stats window as an array of objects.
   */
  get window () {
    return this[STATS_WINDOW].slice();
  }

  /**
   * The number of times the action for this breaker executed successfully
   * during the current statistical window.
   */
  get successes () {
    return this[STATS_WINDOW][0].successes;
  }

  /**
   * The number of times the breaker's action has failed
   * during the current statistical window.
   */
  get failures () {
    return this[STATS_WINDOW][0].failures;
  }

  /**
   * The number of times a fallback function has been executed
   * during the current statistical window.
   */
  get fallbacks () {
    return this[STATS_WINDOW][0].fallbacks;
  }

  /**
   * The number of times during the current statistical window that
   * this breaker been rejected because it was in the open state.
   */
  get rejects () {
    return this[STATS_WINDOW][0].rejects;
  }

  /**
   * The number of times this circuit breaker has been fired
   * during the current statistical window.
   */
  get fires () {
    return this[STATS_WINDOW][0].fires;
  }

  /**
   * The number of times this circuit breaker has timed out
   * during the current statistical window.
   */
  get timeouts () {
    return this[STATS_WINDOW][0].timeouts;
  }

  /**
   * The number of times this circuit breaker has retrieved
   * a value from the cache instead. If the circuit does not use
   * caching, then this value will always be 0.
   */
  get cacheHits () {
    return this[STATS_WINDOW][0].cacheHits;
  }

  /**
   * The number of times this circuit breaker has looked in the
   * cache and found nothing. If the circuit does not use caching then
   * this value will always be 0.
   */
  get cacheMisses () {
    return this[STATS_WINDOW][0].cacheMisses;
  }
}

const increment =
  (status, property) => () => status[STATS_WINDOW][0][property]++;

const stats = () => ({
  isCircuitBreakerOpen: false,
  failures: 0,
  fallbacks: 0,
  successes: 0,
  rejects: 0,
  fires: 0,
  timeouts: 0,
  cacheHits: 0,
  cacheMisses: 0,
  start: Date.now()
});

module.exports = exports = Status;

},{}],6:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],7:[function(require,module,exports){
(function (global){
(function () {
  'use strict';
   /** Detect free variable `global` from Node.js. */
  var freeGlobal = typeof global === 'object' && global && global.Object === Object && global;

  /** Used as a reference to the global object. */
  var root = freeGlobal || Function('return this')();

  const PENDING = 0;
  const FULFILLED = 1;
  const REJECTED = 2;
  const HANDLERS = Symbol('handlers');
  const QUEUE = Symbol('queue');
  const STATE = Symbol('state');
  const VALUE = Symbol('value');

  /**
   * Represents the eventual result of an asynchronous operation.
   */
  class FidelityPromise {
    /**
     * Creates a new FidelityPromise.
     * @param {function} - The executor function. It is executed immediately,
     * and should accept two resolver functions, 'resolve' and 'reject'.
     * Calling them either fulfills or rejects the promise, respectively.
     * Typically, the executor function will initiate some asynchronous task,
     * and the call 'resolve' with the result, or 'reject' if there was an error.
     */
    constructor (fn) {
      this[QUEUE] = [];
      this[HANDLERS] = new Handlers();
      this[STATE] = PENDING;
      this[VALUE] = undefined;

      const fnType = typeof fn;
      if (fnType === 'function') {
        tryFunction(fn, this);
      } else if (fnType !== 'undefined') {
        resolvePromise(this, fn);
      }
    }

    /**
     * Returns the current state of this promise. Possible values are
     * `Fidelity.PENDING`, `Fidelity.FULFILLED`, or `Fidelity.REJECTED`.
     * @return the current state of this promise.
     */
    get state () {
      return this[STATE];
    }

    /**
     * Gets the current value of this promise. May be undefined.
     * @return the current value of this promise
     */
    get value () {
      return this[VALUE];
    }

    /**
     * Follows the [Promises/A+](https://promisesaplus.com/) spec
     * for a `then` function.
     * @param {function} onFulfilled - the function to invoke when this promise
     * has been resolved.
     * @param {function} onRejected - the function to invoke when this promise
     * has been rejected.
     * @return {FidelityPromise}
     */
    then (onFulfilled, onRejected) {
      const next = new FidelityPromise();
      if (typeof onFulfilled === 'function') {
        next[HANDLERS].fulfill = onFulfilled;
      }
      if (typeof onRejected === 'function') {
        next[HANDLERS].reject = onRejected;
      }
      this[QUEUE].push(next);
      process(this);
      return next;
    }

    /**
     * Syntactic sugar for `this.then(null, onRejected)`.
     * @param {function} onRejected - the function to invoke
     * when this promise is rejected.
     * @return {FidelityPromise}
     */
    catch (onRejected) {
      return this.then(null, onRejected);
    }

    /**
     * Creates a promise that will be resolved or rejected at some time
     * in the future.
     * @param {function} fn The function that will do the work of this promise.
     * The function is passed two function arguments, `resolve()` and `reject()`.
     * Call one of these when the work has completed (or failed).
     * @returns {FidelityPromise} A promise object
     * @deprecated Use new FidelityPromise()
     */
    static promise (fn) {
      console.error('Fidelity.promise() is deprecated. Use `new Fidelity.Promise()`.');
      return new FidelityPromise(fn);
    }

    /**
     * Creates a `deferred` object, containing a promise which may
     * be resolved or rejected at some point in the future.
     * @returns {object} deferred The deferred object
     * @returns {function} deferred.resolve(value) The resolve function
     * @returns {function} deferred.reject(cause) The reject function
     * @returns {object} deferred.promise The inner promise object
     */
    static deferred () {
      let resolver, rejecter;
      const p = new FidelityPromise((resolve, reject) => {
        resolver = resolve;
        rejecter = reject;
      });

      return {
        promise: p,
        resolve: (value) => resolver(value),
        reject: (cause) => rejecter(cause)
      };
    }

    /**
     * Returns a promise that is resolved with `value`.
     * @param {any} value The value to resolve the returned promise with
     * @returns {FidelityPromise} A promise resolved with `value`
     */
    static resolve (value) {
      if (value && value.then) return value;

      switch (value) {
        case null:
          return NULL;
        case true:
          return TRUE;
        case false:
          return FALSE;
        case 0:
          return ZERO;
        case '':
          return EMPTYSTRING;
      }

      const p = new FidelityPromise();
      p[STATE] = FULFILLED;
      p[VALUE] = value;
      return p;
    }

    /**
     * Returns a promise that has been rejected.
     * @param {any} reason The reason the promise was rejected
     * @return {FidelityPromise} a rejected promise
     */
    static reject (reason) {
      const p = new FidelityPromise();
      p[STATE] = REJECTED;
      p[VALUE] = reason;
      return p;
    }

    /**
     * Returns the results of all resolved promises, or the
     * cause of the first failed promise.
     * @param {iterable} promises an iterable
     * @returns {any} an Array of results, or the cause of the first rejected promise
     */
    static all (/* promises - an iterable */) {
      const results = [];
      const promises = Array.from(arguments).reduce((a, b) => a.concat(b), []);
      const merged = promises.reduce(
        (acc, p) => acc.then(() => p).then(r => results.push(r)),
        Promise.resolve(null));
      return merged.then(_ => results);
    }

    /**
     * Returns a promise that resolves or rejects as soon as one of the
     * promises in the supplied iterable resolves or rejects with the value
     * or reason from that promise.
     * @param {iterable} promises an iterable
     * @returns {any} the first value or cause that was resolved or rejected by
     * one of the supplied promises.
     */
    static race (/* promises - an iterable */) {
      const promises = Array.from(arguments).reduce((a, b) => a.concat(b), []);
      return new FidelityPromise((resolve, reject) => {
        promises.forEach(p => p.then(resolve).catch(reject));
      });
    }
  }

  FidelityPromise.PENDING = PENDING;
  FidelityPromise.FULFILLED = FULFILLED;
  FidelityPromise.REJECTED = REJECTED;

  class Handlers {
    constructor () {
      this.fulfill = null;
      this.reject = null;
    }
  }

  const nextTick = (() => {
    if (root.process && typeof root.process.nextTick === 'function') {
      return root.process.nextTick;
    } else if (typeof root.setImmediate === 'function') {
      return root.setImmediate;
    } else if (typeof root.setTimeout === 'function') {
      return (f, p) => root.setTimeout(f, 0, p);
    } else {
      console.error('No nextTick. How we gonna do this?');
      return (f, p) => f.call(this, p);
    }
  })();

  function exportModule (exported) {
    if (typeof module === 'object' && module.exports) {
      // we're in a node.js environment
      module.exports = exported;
    } else {
      // in a browser environment
      root[exported.name] = exported;
    }
  }

  const TRUE = new FidelityPromise(true);
  const FALSE = new FidelityPromise(false);
  const NULL = new FidelityPromise(null);
  const ZERO = new FidelityPromise(0);
  const EMPTYSTRING = new FidelityPromise('');

  function tryFunction (fn, promise) {
    try {
      fn(v => resolvePromise(promise, v), r => transition(promise, REJECTED, r));
    } catch (e) {
      transition(promise, REJECTED, e);
    }
  }

  function resolvePromise (p, x) {
    if (x === p) {
      transition(p, REJECTED, new TypeError('The promise and its value are the same.'));
      return;
    }

    const typeOfX = typeof x;
    if (x && ((typeOfX === 'function') || (typeOfX === 'object'))) {
      let called = false;
      try {
        const thenFunction = x.then;
        if (thenFunction && (typeof thenFunction === 'function')) {
          thenFunction.call(x, (y) => {
            if (!called) {
              resolvePromise(p, y);
              called = true;
            }
          }, (r) => {
            if (!called) {
              transition(p, REJECTED, r);
              called = true;
            }
          });
        } else {
          transition(p, FULFILLED, x);
          called = true;
        }
      } catch (e) {
        if (!called) {
          transition(p, REJECTED, e);
          called = true;
        }
      }
    } else {
      transition(p, FULFILLED, x);
    }
  }

  function process (p) {
    if (p[STATE] === PENDING) return;
    nextTick(processNextTick, p);
    return p;
  }

  function processNextTick (p) {
    let handler, qp;
    while (p[QUEUE].length) {
      qp = p[QUEUE].shift();
      if (p[STATE] === FULFILLED) {
        handler = qp[HANDLERS].fulfill || ((v) => v);
      } else if (p[STATE] === REJECTED) {
        handler = qp[HANDLERS].reject || ((r) => {
          throw r;
        });
      }
      try {
        resolvePromise(qp, handler(p[VALUE]));
      } catch (e) {
        transition(qp, REJECTED, e);
        continue;
      }
    }
  }

  function transition (p, state, value) {
    if (p[STATE] === state ||
      p[STATE] !== PENDING) return;
    p[STATE] = state;
    p[VALUE] = value;
    return process(p);
  }

  exportModule(FidelityPromise);
}.call(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],8:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[1,2,3,4,5]);
