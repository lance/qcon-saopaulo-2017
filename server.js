const nodeStatic = require('node-static');
var file = new nodeStatic.Server('./docs');

require('http').createServer((request, response) =>
  request.addListener('end', () => file.serve(request, response)).resume()
).listen(8000);
