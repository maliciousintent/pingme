/*jshint node:true, strict:true, laxcomma:true, eqnull:true, undef:true, unused:true, white:true, indent:2 */

'use strict';

var NOTIFY_FROM = process.env.NOTIFY_FROM
  , NOTIFY_TO = process.env.NOTIFY_TO;

require('sugar');

var express = require('express')
  , http = require('http')
  , path = require('path')
  , redis = require('redis')
  , moment = require('moment')
  , async = require('async');
  
var app = express()
  , rclient = redis.createClient();

rclient.on('error', function (err) {
  console.log('REDIS ERROR', err);
});


// -$- Express -$-

app.set('port', process.env.PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.errorHandler());


// -$- Routes -$-

app.get('/', function (req, res) {
  res.render('index');
});


app.post('/add', function (req, res) {
  var name = req.param('name')
    , url = req.param('url');
  
  if (!_requireNotEmpty(name, url)) {
    return res.status(400).end('One or more required parameters are missing.');
  }
  
  rclient.hset('websites', name, url, function () {
    return res.status(201).end('Website added.');
  });
});


app.del('/delete', function (req, res) {
  var name = req.param('name');
  
  if (!_requireNotEmpty(name)) {
    return res.status(400).end('One or more required parameters are missing.');
  }
  
  rclient.hdel('websites', name, function () {
    return res.status(201).end('Website removed.');
  });
});


app.get('/list', function (req, res, next) {
  rclient.hgetall('websites', function (err, websites) {
    if (err) {
      return next(err);
    }
    
    rclient.hgetall('websites-status', function (err, statuses) {
      if (err) {
        return next(err);
      }
      
      statuses = statuses || {};
      
      res.render('list', {
        websites: websites
      , statuses: Object.map(statuses, function (key, value) { var ret = value.split('|'); ret[1] = moment(ret[1]).fromNow(); return ret; })
      , timeout_ms: 300
      });
    });
  });
});


http.createServer(app).listen(app.get('port'), function () {
  console.log('Express server listening on port ' + app.get('port'));
});


// -$- Worker -$-

function _worker() {
  console.log('Worker has started...');
  
  rclient.hgetall('websites', function (err, websites) {
    if (err) {
      throw err;
    }
    
    async.forEach(Object.keys(websites), function (name, nextEach) {
      var resptime = new Date().valueOf();
      
      async.waterfall([
        function _request(nextSeries) {
          http.get(websites[name], function (res) {
            console.log('Status code', res.statusCode);
            
            nextSeries(null, {
              ok: (res.statusCode === 200) ? 'ok' : 'no'
            , resptime: (res.statusCode === 200) ? new Date().valueOf() - resptime : res.statusCode
            });
              
          }).on('error', function (e) {
            nextSeries(null, {
              ok: 'no'
            , resptime: e.errno
            });
          });
        },
        
        function _complete(status, nextSeries) {
          rclient.hset('websites-status', name, [status.ok, new Date(), status.resptime].join('|'), nextSeries);
        }
      ], nextEach);
    });
  });
  
  setTimeout(_worker, 5000);
}
setTimeout(_worker, 5000);


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
