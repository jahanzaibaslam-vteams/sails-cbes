/**
 * Module dependencies
 */

var couchbase = require('couchbase'),
    elasticSearch = require('elasticsearch'),
    _ = require('lodash');

/**
 * Manage a connection to a CB & ES Server
 *
 * @param {Object} config
 * @return {Object}
 * @api private
 */
var Connection = module.exports = function Connection(config, collections, cb) {
    var self = this;
    // Hold the config object
    this.config = config || {};

    // Build Database connection
    this._buildConnection(collections, function (err, db) {
        if (err) {
            return cb(err);
        }

        // Store the DB object
        self.db = db;

        // Return the connection
        cb(null, self);
    });
};

/////////////////////////////////////////////////////////////////////////////////
// PRIVATE METHODS
/////////////////////////////////////////////////////////////////////////////////

/**
 * @param view
 * @param callback
 * @private
 */
Connection.prototype._initCouchBase = function(view, callback){
    var self = this,
        config = self.config.cb,
        cb = new couchbase.Cluster('couchbase://' + config.host, config.user, config.pass),
        bucket = cb.openBucket(config.bucket.name, config.bucket.pass),
        manager = bucket.manager();

    manager.upsertDesignDocument(config.bucket.name, view, function(err, res){
        if (err) {
            return callback(err, false);
        }

        callback(false, bucket);
    });
};

/**
 * @param allMappings
 * @param callback
 * @private
 */
Connection.prototype._initElasticSearch = function(allMappings, callback){
    var self = this,
        config = self.config.es,
        es = new elasticSearch.Client({host: config.host, log: config.log});

    /**
     * @param callback
     */
    function getMappingList(callback){
        es.indices.getMapping({index: config.index}, function(err, res, status){
            if (err) {
                return callback(err, false);
            }

            if (res.hasOwnProperty(config.index) && res[config.index].hasOwnProperty('mappings')) {
                var mappingList = res[config.index]['mappings'];
                return callback(false, mappingList);
            }

            return callback(false, {});
        });
    }

    /**
     * @param mapping
     */
    function importMapping(mapping){
        getMappingList(function(err, mappings){
            if (err) {
                return console.log(new Error(err));
            }

            if (mappings.hasOwnProperty(mapping.type)) {
                var opt = {
                    index: config.index,
                    type: mapping.type
                };

                es.indices.deleteMapping(opt, function(err, res, status){
                    if (err) {
                        return console.log(new Error(err));
                    }

                    putMapping(mapping, function(err){
                        if (err) {
                            return console.log(new Error(err));
                        }
                    });
                });
            } else {
                putMapping(mapping, function(err){
                    if (err) {
                        return console.log(new Error(err));
                    }
                });
            }
        });
    }

    /**
     * @param mapping
     * @param callback
     */
    function putMapping(mapping, callback){
        es.indices.putMapping(mapping, function(err, res, status){
            if (err) {
                return callback(err);
            }

            return callback(false);
        });
    }

    es.indices.exists({index: config.index}, function(err, res, stat){
        if (err) {
            return callback(err, false);
        }

        if (res === false) {
            var params = {
                index: config.index,
                body: {
                    settings: {
                        number_of_shards: 5,
                        number_of_replicas: 0
                    }
                }
            };

            return es.indices.create(params, function(err, response, status){
                if (err) {
                    return callback(err, false);
                }

                for (var key in allMappings) {
                    importMapping(allMappings[key]);
                }

                /** sleep 5s untill elastic search updates the mappings **/
                setTimeout(function(){
                    callback(false, es);
                }, 5000);
            });
        }
        callback(false, es);
    });
};

/**
 * Build Server and Database Connection Objects
 *
 * @param {Function} cb
 * @api private
 */
Connection.prototype._buildConnection = function _buildConnection(collections, cb) {
    var self = this,
        i = 0,
        view = {},
        mappings = [];

    var mapping = {
        index: self.config.es.index,
        type: null,
        body: {
            properties: {}
        }
    };

    view.views = {};
    view.options = {
        updateInterval         : 2500,
        updateMinChanges       : 5000,
        replicaUpdateMinChanges: 5000
    };

    Object.keys(collections).forEach(function(key){
        var name = key.replace("model", "");
        view.views[name] = {
            map: "function (doc, meta) {" +
                "if(doc._TYPE_ && doc._TYPE == '" + name + "') {" +
                    "emit(meta.id, doc);" +
                "}" +
            "}"
        };

        if (typeof collections[key].mapping == 'object') {
            var _tmp = _.cloneDeep(mapping);
            _tmp.type = name;
            _tmp.body.properties = collections[key].mapping;

            mappings.push(_tmp);
        }

        i++;
        if (Object.keys(collections).length == i) {
            self._initCouchBase(view, function(err, bucket){
                if (err) {
                    return cb(err, false);
                }

                self._initElasticSearch(mappings, function(err, es){
                    if (err) {
                        return cb(err, false);
                    }

                    cb(false, {cb: bucket, es: es});
                });
            });
        }
    });
};