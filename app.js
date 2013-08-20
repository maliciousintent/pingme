/*jshint node:true, strict:true, laxcomma:true, eqnull:true, undef:true, unused:true, white:true, indent:2 */

'use strict';

var HIPCHAT_TOKEN = process.env.HIPCHAT_TOKEN;

var WORKER_INTERVAL = 60 * 1000
  , WORKER_INITIAL_TIMEOUT = 1000
  , SOCKET_TIMEOUT = 10000
  , TEMPLATE_TIMEOUT_WARNING = 300;

require('sugar');

var express = require('express')
  , http = require('http')
  , https = require('https')
  , path = require('path')
  , redis = require('redis')
  , moment = require('moment')
  , async = require('async')
  , flash = require('connect-flash')
  , HipChatClient = require('node-hipchat');
  
var app = express()
  , rclient = redis.createClient()
  , hip = new HipChatClient(HIPCHAT_TOKEN)
  , prev_failing = [];

rclient.on('error', function (err) {
  console.log('REDIS ERROR', err);
  throw err;
});


// -$- Express -$-

app.set('port', process.env.PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(express.cookieParser());
app.use(express.session({ secret: 'alksdmfjiolwmf' }));
app.use(flash());
app.use(app.router);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.errorHandler());


// -$- Routes -$-

app.get('/', function (req, res, next) {
  
  rclient.hgetall('websites-status', function (err, statuses) {
    if (err) {
      return next(err);
    }
    
    statuses = statuses || {};
    
    var online, offline;
    online = Object.reduce(Object.map(statuses, function (key, value) { 
      if (value.split('|')[0] === 'ok') {
        return 1;
      } else {
        return 0;
      }
    }), function (a, b) { return a + b; }, 0);    
    offline = Object.size(statuses) - online;
    
    res.render('index', {
      online: online
    , offline: offline
    });
  });
  
});


app.post('/add', function (req, res) {
  var name = req.param('name')
    , url = req.param('url');
  
  if (!_requireNotEmpty(name, url)) {
    return res.status(400).end('One or more required parameters are missing.');
  }
  
  rclient.hset('websites', name, url, function () {
    req.flash('message', 'Website "' + name + '" added.');
    return res.redirect('/list');
  });
});


app.del('/delete', function (req, res) {
  var name = req.param('name');
  
  if (!_requireNotEmpty(name)) {
    return res.status(400).end('One or more required parameters are missing.');
  }
  
  rclient.hdel('websites', name, function () {
    rclient.hdel('websites-status', name, function () {
      req.flash('message', 'Website "' + name + '" removed.');
      return res.redirect('/list');
    });
  });
});


app.get('/list', function (req, res, next) {
  rclient.hgetall('websites', function (err, websites) {
    if (err) {
      return next(err);
    }
    
    var a_websites = [];
    websites = websites || {};
    
    Object.keys(websites).forEach(function (key) {
      a_websites.push({ key: key, value: websites[key] });
    });
    
    rclient.hgetall('websites-status', function (err, statuses) {
      if (err) {
        return next(err);
      }
      
      statuses = statuses || {};
      
      var offline = Object.reduce(Object.map(statuses, function (key, value) { 
        if (value.split('|')[0] !== 'ok') {
          return 1;
        } else {
          return 0;
        }
      }), function (a, b) { return a + b; }, 0);    
      
      res.render('list', {
        websites: a_websites.sortBy(function (row) { return [('string' === typeof statuses[row.key]) ? statuses[row.key].split('|')[0]: 'unknown', row.key]; })
      , statuses: Object.map(statuses, function (key, value) { var ret = value.split('|'); ret[2] = moment(ret[2]).fromNow(); return ret; })
      , timeout_ms: TEMPLATE_TIMEOUT_WARNING
      , offline: offline
      , interval: WORKER_INTERVAL
      , message: req.flash('message')
      });
    });
  });
});


app.get('/u', function (req, res, next) {
  // Micro status-page
   
  rclient.hgetall('websites-status', function (err, statuses) {
    if (err) {
      return next(err);
    }
    
    statuses = statuses || {};
    
    var offline = Object.sum(Object.map(statuses, function (key, value) { return (value.split('|')[0] === 'ok') ? 0 : 1; }));
    
    res.render('u', {
      offline: offline
    , interval: WORKER_INTERVAL
    , time: moment().format('LT')
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
    
    var failing = [];
    websites = websites || {};
    
    async.each(Object.keys(websites), function (name, nextEach) {
      var resptime = new Date().valueOf();
      
      async.waterfall([
        function _request(nextSeries) {
          var req = ((websites[name].indexOf('https://') === 0) ? https : http).request(websites[name]);
          
          req.on('response', function (res) {
            process.nextTick(function () {
              nextSeries(null, {
                ok: (res.statusCode === 200) ? 'ok' : 'no'
              , code: res.statusCode
              , resptime: new Date().valueOf() - resptime
              });
            });
            
            req.abort();
          });
          
          req.on('error', function (e) {
            nextSeries(null, {
              ok: 'no'
            , code: e.errno
            , resptime: '(TIMEOUT)'
            });
          });
          
          req.setTimeout(SOCKET_TIMEOUT, function () {
            req.abort();
          });
          
          req.end();
        },
        
        function _complete(status, nextSeries) {
          if (status.ok !== 'ok') {
            if (prev_failing.indexOf(name) === -1) {
              // Send only 1st notification
              _hipNotify('red', 'Status Check Failing for website ' + name + ' at url ' + websites[name] + '. Please investigate.');
            }
            
            failing.push(name);
          }
          
          console.log('failing:', failing, prev_failing);
          
          rclient.hset('websites-status', name, [status.ok, status.code, new Date(), status.resptime].join('|'), function () {
            nextSeries();
          });
        }
      ], function () {
        nextEach();
      });
      
    }, function _forEachComplete() {
      if (prev_failing.length > 0 && failing.length === 0) {
        _hipNotify('green', 'All websites are now online.');
      }
      
      prev_failing = failing.clone();
      
      console.log('Worker exited.');
      setTimeout(_worker, WORKER_INTERVAL);
    });
  });
}
setTimeout(_worker, WORKER_INITIAL_TIMEOUT);


// -$- Utils -$-

function _hipNotify(color, msg) {
  hip.postMessage({
    room: 'Notifications'
  , from: 'PingMe'
  , message: msg
  , message_format: 'text'
  , notify: 1
  , color: color
  }, function (status, err) {
    if (err) {
      console.warn('HipChat API Error', err);
    }
  });
}


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
