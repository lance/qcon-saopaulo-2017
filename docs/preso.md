layout: true

{{content}}

.footer[
  ![Red Hat logo](redhat-logo.jpg)
]

---
# Microservice Resiliency
## From Front to Back End


### QCon São Paulo, 2017

Lance Ball,
Senior Software Engineer,
Red Hat

---

class: center

## Who am I?

### Senior Software Engineer, Red Hat

--

![jboss logo](jboss-logo.png)

--

![project:odd logo](projectodd-logo.png)

--

![Node logo](nodejs-logo-wide.png)

---

## µ Service


> software applications as suites of independently deployable services

https://martinfowler.com/articles/microservices.html

--

## But what does this mean?!

---
class: center, middle
## What's in an application?

---

class: center

## Stuff

![Application services](services.png)

---
class: center

## Monolithic application

![Application monolith](monolith.png)

???
Each of the various services of the application all live within a
single process. This could be a Java EE application server, or just
a PHP application. The point is that all of the "stuff" in your application
is bundled together as a whole.

---
class: center

## Scaling a monolith

![Scaled monolith](scaled-monolith.png)

???
The entire application is replicated when scaling a monolith.

---
class: center

## Microservice application

![Microservice deployment](microservice-deployment.png)

---
class: center

## Scaled microservices

![Scaled microservices](scaled-microservices.png)

???
"Microservice deployment" here could mean a replicated Docker container
or a Kubernetes pod or an Heroku dyno that can be scaled up as demand
increases, independently of other services.

Remember, the key here is that each service can be scaled independently
of the others. Your pricing "reviews" service will never be as busy as
your pricing service. So, these two processes should not scale together.

---
class: center, middle

## Wait... isn't this the UX track?

---
## Service Lifecycle

![Microservice lifecycle](lifecycle.png)

--

* Client makes a request
--

* Server provides a response
--

* Often using HTTP transport
--

* Often with JSON data format
---
## In the Browser

![Browser request lifecycle](browser-lifecycle.png)

--

* XMLHttpRequest
--

* JQuery
--

* AJAX
---
class: center

## Microservice Requests
### (simplified)

![Microservice request](microservice-request.png)

???

This is a simplified view.
In fact, if you want to actually visualize a µService app,
see the next slide.

---
class: center, middle

## Operational Complexity

???
OPERATIONAL COMPLEXITY

µ-services are not inherently simpler. The complexity is shifted
from code and design to systems and operations.

---

class: center

## Microservices Visualized

<video width="398" height="378" autoplay loop>
  <source src="https://video.twimg.com/tweet_video/C7sOlUjVYAEzz0y.mp4" type="video/mp4">

https://twitter.com/ThePracticalDev/status/845285541528719360

---

## Problems

--

* Timeouts

--

* Network saturation


--

* Programmer error

--

* Disk failure

--

* Transitive dependencies

???

If your application uses any kind of I/O

---

class: center

## Cascading failures

![Cascading failures](cascading-failure.png)

---

class: center, middle

![Sysiphus](giphy.gif)

---

# How to deal with all this

--

* Limit single points of failure

--

* Shed load when possible

--

* Provide fallback behavior

--

* Optimize failure discovery

---

## Circuit Breaker
--

* Calls that could fail are wrapped

--

* Circuit opens at a failure threshold

--

* Further calls short circuit for a while

--

* Later, circuit tries again and trips immediately if there is failure

---
class: middle, center

![Flow chart](flowchart.png)

---
class: middle, center

## Circuit State

![State](state.png)

---

## Async operation that could fail

```js
// Use JQuery to get cart info
$.get('http://mystore.com/cart')
  .then((json) => {
    // update the UI with JSON data
  })
  .catch((e) => {
    // oops something went wrong
   console.error(e);
  })
```

--

### Shed load when possible

???
This is fine, but it ignores the fact that the server may
be continually failing, and has no mechanism builtin to
allow for throttling back.

Fallback behavior could be implemented in the catch
clause, but may end up duplicating implementation of
the success condition.

---

## Aside - Promsies

```js
// Use JQuery to get cart info
$.get('http://mystore.com/cart')
* .then((json) => {
    // update the UI with JSON data
  })
* .catch((e) => {
    // oops something went wrong
   console.error(e);
  })
```
---

## Circuit Breaker Example

```js
// Use JQuery's ajax wrapper and circuit breaker
// defaults for failure threshold, timing, etc.
const circuit = circuitBreaker($.get);

circuit.fire('http://nodejs.org/dist/index.json')
  .then((json) => {
    // update the UI with JSON data
  })
  // on failure, just log to console
  .catch(console.error);
```

???

Doesn't look that much different than the original.
But this version allows your code to automatically
throttle requests to allow the server to recover.

Note the promise API in use here. What about callbacks?
Node uses callbacks everywhere...

---

## Circuit Breaker Example

```js
// Use JQuery's ajax wrapper and circuit breaker
// defaults for failure threshold, timing, etc.
*const circuit = circuitBreaker($.get);

circuit.fire('http://nodejs.org/dist/index.json')
  .then((json) => {
    // update the UI with JSON data
  })
  // on failure, just log to console
  .catch(console.error);
```

---

## Circuit Breaker Example

```js
// Use JQuery's ajax wrapper and circuit breaker
// defaults for failure threshold, timing, etc.
const circuit = circuitBreaker($.get);

*circuit.fire('http://nodejs.org/dist/index.json')
  .then((json) => {
    // update the UI with JSON data
  })
  // on failure, just log to console
  .catch(console.error);
```

---

## Promises vs. Callbacks

```js
// Wrap Node.js' fs.readFile as a promise-returning function
*const readFile = circuitBreaker.promisify(fs.readFile);

const circuit = circuitBreaker(readFile, options);

circuit.fire('./package.json', 'utf-8')
  .then(console.log)
  .catch(console.error);
```

???

Switch to terminal and do this example.
Use the error output to point out the need for a fallback

---

## Circuit Breaker Fallback

### Provides default behavior in case of error

```js
*circuit.fallback((file) => `Sorry, I can't read ${file}`);

// Fallback function is still a success case
circuit.fire('./package.jsob')
  .then((data) => console.log(`package.json: \n${data}`))
  .catch((err) => console.error(`ERR: ${err}`));
```

???
A circuit breaker's fallback is just a function. But you can also
supply a circuit as a fallback. Neat, huh?
---

## Circuit Breaker Fallback

### Provides default behavior in case of error

```js
circuit.fallback((file) => `Sorry, I can't read ${file}`);

// Fallback function is still a success case
*circuit.fire('./package.jsob')
  .then((data) => console.log(`package.json: \n${data}`))
  .catch((err) => console.error(`ERR: ${err}`));
```

???
Go back to the console to demonstrate this. But DO NOT USE MULTILINE.

---

## Caching
### Always returns the same value

```js
const now = circuitBreaker(Date, { cache: true });
```

--
```js
circuit.fire().then(console.log);
// Mon Apr 10 2017 12:10:26 GMT-0400 (EDT)
circuit.fire().then(console.log);
// Mon Apr 10 2017 12:10:26 GMT-0400 (EDT)
circuit.fire().then(console.log);
// Mon Apr 10 2017 12:10:26 GMT-0400 (EDT)
```

---

## When is this useful?

* Frequent hits, infrequent change
* E.g. username

```js
const username = circuitBreaker(fetchUsername, { cache: true });

// periodically clear the cache
setInterval(_ => username.clearCache(), 5000);
```

---

## Events

Circuit breakers are event emitters


```js
  // Update the UI specifically for timeout errors
*  circuit.on('timeout',
    () => $(element).prepend(
      mkNode(`${route} is taking too long to respond.`)));
```
--
<div style='float:left;width:50%'>
<ul class='events'>
  <li>`fire`</li>
  <li>`reject`</li>
  <li>`timeout`</li>
  <li>`success`</li>
  <li>`failure`</li>
</ul>
</div>

<div style='float:right;width:50%'>
<ul class='events'>
  <li>`open`</li>
  <li>`close`</li>
  <li>`halfOpen`</li>
  <li>`fallback`</li>
  <li>`snapshot`</li>
</ul>
</div>

---

## Status

```js
*// create a 10 sec window with 10 buckets of 1 sec
*const circuit = circuitBreaker(asyncFunc, {
*  rollingCountTimeout: 10000,
*  rollingCountBuckets: 10
*});

// status is calculated every time status is accessed
const status = circuit.status

// print the entire statistical window
console.log(status.window);

// print the rolling stats
console.log(status.stats);
```

---

## Status

```js
// create a 10 sec window with 10 buckets of 1 sec
const circuit = circuitBreaker(asyncFunc, {
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10
});

*// status is calculated every time status is accessed
*const status = circuit.status

// print the entire statistical window
console.log(status.window);

// print the rolling stats
console.log(status.stats);
```

---
## Status

```js
// print the rolling stats
console.log(status.stats);

*// { failures: 3,
*//   fallbacks: 4,
*//   successes: 44,
*//   rejects: 4,
*//   fires: 48,
*//   timeouts: 1,
*//   cacheHits: 0,
*//   cacheMisses: 0 }

```

---

## Dashboard

![Hystrix Dashboard](dashboard-annoted-circuit-640.png)
<div class='right' style='font-size:small'>http://techblog.netflix.com/2012/12/hystrix-dashboard-and-turbine.html</div>

---
## Demo

---
class: center

## Obrigado & Questions

<span class='left' style='font-size:large'>
http://lanceball.com/qcon-saopaulo-2017/<br/>
https://github.com/lance/qcon-saopaulo-2017<br/>
Twitter - @lanceball<br/>
GitHub - @lance
</span>

<span class='right'>
<img src='handsup.png' alt='questions'/>
</span>

