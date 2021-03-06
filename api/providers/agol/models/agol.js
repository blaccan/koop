var request = require('request'),
  async = require('async');

var AGOL = function(){

  // how to long to persist the cache of data 
  // after which data will be dropped and re-fetched
  this.cacheLife = (24*60*60*1000);  

  // adds a service to the Cache.db
  // needs a host, generates an id 
  this.register = function( id, host, callback ){
    var type = 'agol:services';
    //var id = (new Date()).getTime();
    Cache.db.services.count( type, function(error, count){
      id = id || count++;
      Cache.db.services.register( type, {'id': id, 'host': host},  function( err, success ){
        callback( err, id );
      });
    });
  };

  this.remove = function( id, callback ){
    Cache.db.services.remove( 'agol:services', parseInt(id) || id,  callback);
  }; 

  // get service by id, no id == return all
  this.find = function( id, callback ){
    Cache.db.services.get( 'agol:services', parseInt(id) || id, callback);
  };

  this.agol_path = '/sharing/rest/content/items/';

  // got the service and get the item
  this.getItem = function( host, itemId, options, callback ){
    var url = host + this.agol_path + itemId+'?f=json';
    request.get(url, function(err, data ){
      if (err) {
        callback(err, null);
      } else {
        var json = JSON.parse( data.body );
        if (json.error){
          callback( json.error.message, null );  
        } else{
          callback( null, json );
        }
      }
    });
  };

  // got the service and get the item
  this.getItemData = function( host, itemId, options, callback ){
    var self = this;
    this.getItem(host, itemId, options, function( err, itemJson ){
      
      if ( err ){
        callback(err, null);
      } else {
        // put host in option so our cacheCheck has ref to it 
        options.host = host;

        var qKey = ['agol', itemId, (options.layer || 0)].join(':');

        Cache.getInfo( qKey, function(err, info){
          
          var is_expired = info ? ( new Date().getTime() >= info.expires_at ) : false;
          if ( is_expired ) {
            Cache.remove('agol', itemId, options, function(err, res){
              if ( itemJson.type == 'Feature Collection' ){
                self.getFeatureCollection( host + self.agol_path, itemId, itemJson, options, callback );
              } else if ( itemJson.type == 'Feature Service' || itemJson.type == 'Map Service' ) {
                self.getFeatureService( itemId, itemJson, options, callback );
              } else {
                callback('Requested Item must be a Feature Collection', null);
              }
            });
          } else {
            if ( itemJson.type == 'Feature Collection' ){
              self.getFeatureCollection( host + self.agol_path, itemId, itemJson, options, callback );
            } else if ( itemJson.type == 'Feature Service' || itemJson.type == 'Map Service' ) {
              self.getFeatureService( itemId, itemJson, options, callback );
            } else {
              callback('Requested Item must be a Feature Collection', null);
            }
          }
        });

      }
    });
  };

  this.getFeatureCollection = function(base_url, id, itemJson, options, callback){
    Cache.get( 'agol', id, options, function(err, entry ){
      if ( err ){
        var url = base_url + '/' + id + '/data?f=json'; 
        request.get(url, function(err, data ){
          if (err) {
            callback(err, null);
          } else {
            var json = JSON.parse( data.body ).featureCollection.layers[0].featureSet;
            GeoJSON.fromEsri( json, function(err, geojson){
              Cache.insert( 'agol', id, geojson, (options.layer || 0), function( err, success){
                if ( success ) {
                  itemJson.data = [geojson];
                  callback( null, itemJson );
                } else {
                  callback( err, null );
                }
              });
            });
          }
        });
      } else {
        itemJson.data = entry;
        callback( null, itemJson );
      }
    });
  };

  this.getFeatureService = function( id, itemJson, options, callback){
    var self = this;
    if ( !itemJson.url ){
      callback( 'Missing url parameter for Feature Service Item', null );
    } else {

      Cache.get( 'agol', id, options, function(err, entry ){
        if ( err ){
          // no data in the cache; request new data 
          self.makeFeatureServiceRequest( id, itemJson, options, callback );
 
        } else if ( entry && entry[0] && entry[0].status == 'processing' ){
          itemJson.data = [{features:[]}];
          itemJson.koop_status = 'processing';
          callback(null, itemJson);
        } else {
          itemJson.data = entry;
          callback( null, itemJson );
        }            
      });
    }
  };


  this.makeFeatureServiceRequest = function( id, itemJson, options, callback ){
    var self = this;
    // get the ids only
    var idUrl = itemJson.url + '/' + (options.layer || 0) + '/query?where=1=1&returnIdsOnly=true&returnCountOnly=true&f=json';

    if (options.geometry){
      idUrl += '&spatialRel=esriSpatialRelIntersects&geometry=' + JSON.stringify(options.geometry);
    }

    // get the id count of the service 
    request.get(idUrl, function(err, serviceIds ){
      // determine if its greater then 1000 
      try {
        var idJson = JSON.parse(serviceIds.body);
        if (idJson.error){
          callback( idJson.error.message + ': ' + idUrl, null );
        } else {
          console.log('COUNT', idJson.count, id);

          // WHEN COUNT IS 0 - No Features 
          if (idJson.count == 0){

            // return empty geojson
            itemJson.data = [{type: 'FeatureCollection', features: []}];
            callback( null, itemJson );

          // Count is low 
          } else if (idJson.count < 1000){
            self.singlePageFeatureService( id, itemJson, options, callback );
          // We HAVE to page 
          } else {
            self.pageFeatureService( id, itemJson, idJson.count, options, callback );
          }
        }
      } catch (e) {
        callback( 'Unknown layer, make the layer you requested exists', null );
      }
    });
  };



  // make a request to a single page feature service 
  this.singlePageFeatureService = function( id, itemJson, options, callback ){
    var self = this;
    // we can the data in one shot
    var url = itemJson.url + '/' + (options.layer || 0) + '/query?outSR=4326&where=1=1&f=json&outFields=*';
    if (options.geometry){
      url += '&spatialRel=esriSpatialRelIntersects&geometry=' + JSON.stringify(options.geometry);
    }
    // get the features 
    request.get(url, function(err, data ){
      if (err) {
        callback(err, null);
      } else {
        try {
          var json = {features: JSON.parse( data.body ).features};
          // convert to GeoJSON 
          GeoJSON.fromEsri( json, function(err, geojson){

            geojson.name = itemJson.name;
            geojson.updated_at = itemJson.modified;
            geojson.expires_at = new Date().getTime() + self.cacheLife;

            // save the data 
            Cache.insert( 'agol', id, geojson, (options.layer || 0), function( err, success){
              if ( success ) {
                itemJson.data = [geojson];
                callback( null, itemJson );
              } else {
                callback( err, null );
              }
            });
          });
        } catch (e){
          callback( 'Unable to parse Feature Service response', null );
        }
      }
    });
  };




  // handles pagin over the feature service 
  this.pageFeatureService = function( id, itemJson, count, options, callback ){
    var self = this;    

    // get the featureservice info 
    self.getFeatureServiceInfo(itemJson.url, ( options.layer || 0 ), function(err, serviceInfo){
      // creates the empty table
      Cache.remove('agol', id, {layer: (options.layer || 0)}, function(){

        var expiration = new Date().getTime() + self.cacheLife;

        var info = {
          status: 'processing',
          updated_at: itemJson.modified,
          expires_at: expiration,
          name: itemJson.name,
          features:[]
        };

        if ( options.format ){
          info.format = options.format;
        }

        
        Cache.insert( 'agol', id, info, ( options.layer || 0 ), function( err, success ){

          // return, but continue on
          itemJson.data = [{ features:[] }];
          itemJson.koop_status = 'processing';
          itemJson.cache_save = false;
          itemJson.expires_at = expiration;
          callback(null, itemJson);

          var maxCount = parseInt(serviceInfo.maxRecordCount),
            pageRequests;

          // build legit offset based page requests 
          if ( serviceInfo.advancedQueryCapabilities.supportsPagination ){

            var nPages = Math.ceil(count / maxCount);
            pageRequests = self.buildOffsetPages( nPages, itemJson.url, maxCount, options );

          } else {
            // build where clause based pages 
            var statsUrl = self.buildStatsUrl( itemJson.url, ( options.layer || 0 ), serviceInfo.objectIdField );

            request.get( statsUrl, function( err, res ){
              var statsJson = JSON.parse(res.body);
              pageRequests = self.buildObjectIDPages(
                itemJson.url,
                statsJson.features[0].attributes.min,
                statsJson.features[0].attributes.max,
                maxCount,
                options
              );
            });

          }

          // queuse up the requests for each page 
          self.requestQueue( count, pageRequests, id, itemJson, (options.layer || 0), function(err,data){
            console.log('...and done');
            Tasker.taskQueue.push( {
              key: [ 'agol', id ].join(':'),
              options: options
            }, function(){});
          });

        });
      });
    });

  };



  //build resultOffset based page requests 
  this.buildOffsetPages = function( pages, url, max, options ){
    var reqs = [], 
      resultOffset;
    for (var i=0; i < pages; i++){

      resultOffset = i*max; 
      var pageUrl = url + '/' + (options.layer || 0) + '/query?outSR=4326&f=json&outFields=*&where=1=1';
      pageUrl += '&resultOffset='+resultOffset;
      pageUrl += '&resultRecordCount='+max;

      if ( options.geometry ){
        pageUrl += '&spatialRel=esriSpatialRelIntersects&geometry=' + JSON.stringify( options.geometry );
      }
      reqs.push({req: pageUrl});
    }

    return reqs;
  };



  //build object id query based page requests 
  this.buildObjectIDPages = function( url, min, max, maxCount, options ){
    var reqs = [], 
      pageMax;

    var pages = Math.ceil(max / maxCount);

    for (i=1; i < pages+1; i++){
      pageMax = i*maxCount;
      where = 'objectId<=' + pageMax + '+AND+' + 'objectId>=' + ((pageMax-maxCount)+1);
      pageUrl = url + '/' + (options.layer || 0) + '/query?outSR=4326&where='+where+'&f=json&outFields=*';
      if ( options.geometry ){
        pageUrl += '&spatialRel=esriSpatialRelIntersects&geometry=' + JSON.stringify(options.geometry);
      }
      reqs.push({req: pageUrl});
    }

    return reqs;
  };


  // make requests for feature pages 
  // execute done when we have all features 
  this.requestQueue = function(max, reqs, id, itemJson, layerId, done){
    var reqCount = 0;
    // setup the place to collect all the features
    itemJson.data = [ {features: []} ];
  
    // aggregate responses into one json and call done we have all of them 
    var _collect = function(json, cb){
      if ( json.error ){
        done( json.error.details[0], null);
      } else {

        reqCount++;

        // insert a partial
        GeoJSON.fromEsri( json, function(err, geojson){
          // concat the features so we return the full json
          itemJson.data[0].features = itemJson.data[0].features.concat( geojson.features );
          Cache.insertPartial( 'agol', id, geojson, layerId, function( err, success){
            cb();
            if (reqCount == reqs.length){
              // pass back the full array of features
              done(null, itemJson);
            }
          });
        });

      }
    };

    var i = 0
    // concurrent queue for feature pages 
    var q = async.queue(function (task, callback) {
      // make a request for a page 
      console.log('get page', i++);
      request.get(task.req, function(err, data){
        try {
          var json = JSON.parse(data.body);
          _collect(json, callback);
        } catch(e){
          console.log('failed to parse json', task.req, data.body, e);
        }
      });
    }, 4);

    // add all the page urls to the queue 
    q.push(reqs, function(err){ if (err) console.log(err); });

  };

  // Gets the feature service info 
  this.getFeatureServiceInfo = function( url, layer, callback ){
    request.get( url +'/'+ layer + '?f=json', function( err, res ){
      var json = JSON.parse( res.body );
      callback( err, json );
    });
  };

  // builds a url for querying the min/max values of the object id 
  this.buildStatsUrl = function( url, layer, field ){
    var json = [{"statisticType":"min","onStatisticField":field,"outStatisticFieldName":"min"},
      {"statisticType":"max","onStatisticField":field,"outStatisticFieldName":"max"}];
    return url+'/'+layer+'/query?f=json&outStatistics='+JSON.stringify(json);
  };

};
  

module.exports = new AGOL();
  
