'use strict';
/* global $ circuitBreaker */

const circuit = (function appInitialization () {
  const route = '/flakeyService';
  const element = '#flakeyResponse';

  const circuitBreakerOptions = {
    timeout: 500,
    errorThresholdPercentage: 50,
    resetTimeout: 5000
  };

  const circuit = circuitBreaker(_ => $.get(route), circuitBreakerOptions);

  circuit.fallback(_ => ({ body: `${route} unavailable right now`, delay: 'fallback' }));

  $(() => {

    $('#flakey').click(_ => circuit.fire()
      .then((result) => makeNode('success', `${result.body}: ${result.delay}`))
      .catch((err) => makeNode('danger', `An unexpected error occurred. ${err}`)));

    $('.clear').click(_ => { $('#flakeyResponse').children().detach(); });
  });

  circuit.status.on('snapshot', (stats) => {
    const response = document.createElement('p');
    $(response).addClass('stats');
    Object.keys(stats).forEach((key) => {
      const p = document.createElement('p');
      p.append(`${key}: ${stats[key]}`);
      $(response).append(p);
    });

    $('#stats').children().replaceWith($(response));
  });

  circuit.on('timeout', _ => makeNode('warning', `TIMEOUT: ${route} is taking too long to respond.`));
  circuit.on('reject', _ => makeNode('info', `REJECTED: The breaker for ${route} is open. Failing fast.`));
  circuit.on('failure', _ =>  makeNode('danger', `FAILURE: The circuit failed.`));
  circuit.on('open', _ =>  makeNode('danger', `OPEN: The breaker for ${route} just opened.`));
  circuit.on('halfOpen', _ => makeNode('warning', `HALF_OPEN: The breaker for ${route} is half open.`));
  circuit.on('close', _ => makeNode('info', `CLOSE: The breaker for ${route} has closed. Service OK.`));

  function makeNode (label, body) {
    const node = document.createElement('div');
    $(node).addClass(label);
    $(node).addClass('alert');
    $(node).addClass(`alert-${label}`);
    node.append(body);
    $(element).prepend(node);
    return node;
  }
  return circuit;
})();
