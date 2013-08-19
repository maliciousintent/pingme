/*jshint node:true, strict:true, laxcomma:true, eqnull:true, undef:true, unused:true, white:true, indent:2 */

'use strict';

var express = require('express')
  , http = require('http')
  , path = require('path')
  , redis = require('redis');
  
var app = express()
  , rclient = redis.createClient();

rclient.on('error', function (err) {
  console.log('REDIS ERROR', err);
});


app.set('port', process.env.PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.errorHandler());

app.get('/', function (req, res) {
  res.render('index');
});

app.post('/add', function (req, res) {
  var name = req.param('name')
    , url = req.param('url')
    , email = req.param('email');
  
  if (!_requireNotEmpty(name, url, email)) {
    return res.status(400).end('One or more required parameters are missing.');
  }
  
  rclient.hset('websites', name, url, function () {
    return res.status(201).end('Website added.');
  });
});

http.createServer(app).listen(app.get('port'), function () {
  console.log('Express server listening on port ' + app.get('port'));
});


// -$- Utils -$-

function _requireNotEmpty() {
  var ret = true;
  
  Array.prototype.forEach.call(arguments, function (arg) {
    if (arg == null || arg.length === 0 || arg === '') {
      ret = false;
      return false;
    }
  });
  
  return ret;
}
