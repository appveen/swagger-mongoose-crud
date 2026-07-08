'use strict';

var _ = require('lodash');
var BaseController = require('./base.controller');
var params = require('./swagger.params.map');

var mongoose = require('mongoose');


const transactionOptions = {
    readPreference: 'primary',
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority' }
}

/**
 * Constructor function for CrudController.
 * @classdesc Controller for basic CRUD operations on mongoose models.
 * Uses the passed id name as the request parameter id to identify models.
 * @constructor
 * @inherits BaseController
 * @param {Model} model - The mongoose model to operate on
 * @param {String} [idName] - The name of the id request parameter to use
 */
function CrudController(model, logger, defaultFilter, permanentDeleteData) {
    // call super constructor
    BaseController.call(this, this);

    // set the model instance to work on
    this.model = model;
    this.logger = logger;
    this.defaultFilter = defaultFilter ? defaultFilter : {};
    this.defaultFilter = this.FilterParse(defaultFilter);
    this.permanentDeleteData = permanentDeleteData;
    // set id name if defined, defaults to 'id'
    this.omit = [];
    _.bindAll(this);
}

function debugLogReq(req, logger) {
    var ob = _.pick(req, ['baseUrl', 'hostname', 'params', 'path', 'query']);
    logger.trace("Getting Request::" + JSON.stringify(ob));
}

async function handleSession(session, abortTransaction) {
    if (abortTransaction) await session.abortTransaction();
    else await session.commitTransaction();
    session.endSession();
}
async function getMongoDbVersion() {
    return (await mongoose.connection.db.admin().serverInfo()).version;
}
async function isTransactionSupported() {
    let version = await getMongoDbVersion();
    let minorVersion = parseFloat(version.substring(0, version.lastIndexOf('.')));
    return minorVersion >= 4.2;
}

function saveDocument(doc, req, docIds, model, self, documents) {
    let docModel = new model(doc);
    if (docIds.indexOf(docModel._id) < 0) {
        return docModel.save(req)
            .then(_d => {
                return { statusCode: 200, message: _d }
            })
            .catch(err => {
                return { statusCode: 400, message: { message: err.message } }
            })
    }
    else {
        let _document = documents.find(_d => _d._id == doc._id);
        let updated = _.mergeWith(_document, doc, self._customizer);
        updated = new self.model(updated);
        Object.keys(doc).forEach(el => updated.markModified(el));
        return updated.save(req)
            .then(_d => {
                return { statusCode: 200, message: _d }
            })
            .catch(err => {
                return { statusCode: 400, message: { message: err.message } }
            })
    }

}

function createDocument(model, body, req, documents, self) {
    let args = [];
    if (Array.isArray(body)) {
        args = body;
    } else {
        args.push(body);
    }
    // let savePromise = [];
    let docIds = documents.map(doc => doc._id);
    let results = [];
    return args.reduce((prev, doc) => {
        return prev.then(async (e) => {
            const result = await saveDocument(doc, req, docIds, model, self, documents);
            results.push(result);
        });
    }, Promise.resolve(null)).then(() => {
        return Promise.resolve(results);
    });
    // args.forEach(doc => {
    //     savePromise.push(saveDocument(doc, req, docIds, model, self, documents));
    // });
    // return Promise.all(savePromise);
}

function removeDocument(doc, req, type) {
    return new Promise(resolve => {
        if (type == "markAsDeleted") {
            doc._metadata.deleted = true;
            doc.save(req)
                .then(doc => {
                    resolve(doc);
                })
                .catch(err => resolve(null));
        } else {
            doc.deleteOne(req)
                .then(() => {
                    resolve(doc.toObject());
                })
                .catch(err => resolve(null));
        }
    });
}

function bulkRemove(self, req, res, type) {
    var reqParams = params.map(req);
    debugLogReq(req, self.logger);
    let document = null;
    var ids = reqParams['id'] ? reqParams['id'].split(',') : [];
    return self.model.find({
        '_id': { "$in": ids },
        '_metadata.deleted': false
    })
        .then(docs => {
            if (!docs) {
                return [];
            }
            let removePromise = docs.map(doc => removeDocument(doc, req, type));
            return Promise.all(removePromise);
        })
        .then((removedDocs) => {
            removedDocs = removedDocs.filter(doc => doc != null);
            let removedIds = removedDocs.map(doc => doc._id);
            var logObject = {
                'operation': 'Delete',
                'user': req.user ? req.user.username : req.headers['masterName'],
                '_id': removedIds,
                'timestamp': new Date()
            };
            self.logger.trace(JSON.stringify(logObject));
            let docsNotRemoved = _.difference(_.uniq(ids), removedIds);
            if (_.isEmpty(docsNotRemoved))
                return self.Okay(res, {});
            else {
                throw new Error("Could not delete document with id " + docsNotRemoved);
            }
        })
        .catch(err => {
            return self.Error(res, err);
        });
}

let invalidAggregationKeys = [
    '$graphLookup',
    '$lookup',
    '$merge',
    '$out',
    '$currentOp',
    '$collStats',
    '$indexStats',
    '$planCacheStats',
    '$listLocalSessions',
    '$listSessions'
];

function validateAggregation(body) {
    if (!body) return true;
    if (Array.isArray(body)) {
        return body.every(_b => validateAggregation(_b));
    }
    if (body.constructor == {}.constructor) {
        return Object.keys(body).every(_k => {
            let flag = invalidAggregationKeys.indexOf(_k) === -1;
            if (!flag) throw new Error(_k + ' is restricted.');
            return flag && validateAggregation(body[_k]);
        });
    }
    return true;
}

CrudController.prototype = {

    /**
     * Set our own constructor property for instanceof checks
     * @private
     */
    constructor: CrudController,

    /**
     * The model instance to perform operations with
     * @type {MongooseModel}
     */
    model: null,

    /**
     * The id  parameter name
     * @type {String}
     * @default 'id'
     */
    idName: 'id',


    /**
     * Flag indicating whether the index query should be performed lean
     * @type {Boolean}
     * @default true
     */
    lean: true,

    /**
     * Array of fields passed to the select statement of the index query.
     * The array is joined with a whitespace before passed to the select
     * method of the controller model.
     * @type {Array}
     * @default The empty Array
     */
    select: [],

    /**
     * Array of fields that should be omitted from the query.
     * The property names are stripped from the query object.
     * @type {Array}
     * @default The empty Array
     */
    omit: [],

    /**
     * Name of the property (maybe a virtual) that should be returned
     * (send as response) by the methods.
     * @type {String}
     * @default The empty String
     */
    defaultReturn: '',
    debugLogger: function (doc, body) {
        var intersection = _.pick(doc, _.keysIn(body));
        this.logger.trace('Object with id :-' + doc._id + ' has been updated, old values:-' + JSON.stringify(intersection) + ' new values:- ' + JSON.stringify(body));
    },
    /**
     * Default Data handlers for Okay Response
     * @type {function}
     * @default Okay response.
     */
    Okay: function (res, data) {
        // this.logger.debug('Sending Response:: ' + JSON.stringify(data))
        res.status(200).json(data);
    },
    /**
     * Default Data handlers for Okay Response
     * @type {function}
     * @default Okay response.
     */
    NotFound: function (res) {
        res.status(404).send();
    },
    IsString: function (val) {
        return val && val.constructor.name === 'String';
    },
    CreateRegexp: function (str) {
        if (str.charAt(0) === '/' &&
            str.charAt(str.length - 1) === '/') {
            var text = str.substr(1, str.length - 2).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
            return new RegExp(text, 'i');
        } else {
            return str;
        }
    },
    IsArray: function (arg) {
        return arg && arg.constructor.name === 'Array';
    },
    IsObject: function (arg) {
        return arg && arg.constructor.name === 'Object';
    },
    ResolveArray: function (arr) {
        var self = this;
        for (var x = 0; x < arr.length; x++) {
            if (self.IsObject(arr[x])) {
                arr[x] = self.FilterParse(arr[x]);
            } else if (self.IsArray(arr[x])) {
                arr[x] = self.ResolveArray(arr[x]);
            } else if (self.IsString(arr[x])) {
                arr[x] = self.CreateRegexp(arr[x]);
            }
        }
        return arr;
    },
    /*
     * Takes the filter field and parses it to a JSON object
     * @type {function}
     *  
     */
    FilterParse: function (filterParsed) {
        var self = this;
        for (var key in filterParsed) {
            if (self.IsString(filterParsed[key])) {
                filterParsed[key] = self.CreateRegexp(filterParsed[key]);
            } else if (self.IsArray(filterParsed[key])) {
                filterParsed[key] = self.ResolveArray(filterParsed[key]);
            } else if (self.IsObject(filterParsed[key])) {
                filterParsed[key] = self.FilterParse(filterParsed[key]);
            }
        }
        return filterParsed;
    },
    /**
     * Default Data handlers for Okay Response
     * @type {function}
     * @default Okay response.
     */
    Error: function (res, err) {
        if (err.errors) {
            var errors = [];
            Object.keys(err.errors).forEach(el => errors.push(err.errors[el].message));
            res.status(400).json({
                message: errors
            });
            // this.logger.debug('Sending Response:: ' + JSON.stringify({ message: errors }));
        } else {
            if (!res.headersSent) {
                res.status(400).json({
                    message: [err.message]
                });
            }
        }
    },
    /**
     * Get a count of results matching a particular filter criteria.
     * @param {IncomingMessage} req - The request message object
     * @param {ServerResponse} res - The outgoing response object the result is set to
     */
    _count: function (req, res) {
        var self = this;
        var reqParams = params.map(req);
        var filter = reqParams['filter'] ? reqParams.filter : {};
        debugLogReq(req, this.logger);
        if (typeof filter === 'string') {
            try {
                filter = JSON.parse(filter);
                filter = self.FilterParse(filter);
            } catch (err) {
                this.logger.error('Failed to parse filter :' + err);
                filter = {};
            }
        }
        filter = _.assign({}, self.defaultFilter, filter);
        if (this.omit.length > 0) {
            filter = _.omit(filter, this.omit);
        }
        if (!this.permanentDeleteData)
            filter['_metadata.deleted'] = false;
        return this.model
            .find(filter)
            .countDocuments()
            .exec()
            .then(result => self.Okay(res, result))
            .catch(err => {
                return self.Error(res, err);
            });
    },
    /**
     * Get a list of documents. If a request query is passed it is used as the
     * query object for the find method.
     * @param {IncomingMessage} req - The request message object
     * @param {ServerResponse} res - The outgoing response object the result is set to
     * @param {Object} options - The options to manipulate response before sending.
     * @returns {ServerResponse} Array of all documents for the {@link CrudController#model} model
     * or the empty Array if no documents have been found
     */
    _index: function (req, res, options) {
        var reqParams = params.map(req);
        debugLogReq(req, this.logger);
        var filter = reqParams['filter'] ? reqParams.filter : {};
        var sort = reqParams['sort'] ? {} : {
            '_metadata.lastUpdated': -1
        };
        reqParams['sort'] ? reqParams.sort.split(',').map(el => el.split('-').length > 1 ? sort[el.split('-')[1]] = -1 : sort[el.split('-')[0]] = 1) : null;
        var select = reqParams['select'] ? reqParams.select.split(',') : [];
        var page = reqParams['page'] ? +reqParams.page : 1;
        var count = reqParams['count'] ? +reqParams.count : 10;
        var search = reqParams['search'] ? reqParams.search : null;
        var metadata = req.query['metadata'] ? req.query.metadata.toLowerCase() == 'true' : false;
        var skip = count * (page - 1);
        var self = this;
        if (typeof filter === 'string') {
            try {
                filter = JSON.parse(filter);
                filter = self.FilterParse(filter);
            } catch (err) {
                this.logger.error('Failed to parse filter :' + err);
                filter = {};
            }
        }
        filter = _.assign({}, self.defaultFilter, filter);
        if (this.omit.length) {
            filter = _.omit(filter, this.omit);
        }
        if (!this.permanentDeleteData)
            filter['_metadata.deleted'] = false;
        if (search) {
            filter['$text'] = { '$search': search };
        }
        var query = this.model.find(filter);

        if (this.lean) {
            query.lean();
        }

        if (this.select.length || select.length) {
            var union = this.select.concat(select);
            query.select(union.join(' '));
        }
        if (count == -1) query.sort(sort)
        else query.skip(skip).limit(count).sort(sort);
        let docs = null;
        let matched = 0, totalCount = 0;
        let resBody = {};
        return query.exec()
            .then(documents => {
                docs = documents;
                let promise = Promise.resolve();
                if (metadata) {
                    promise = this.model.countDocuments(filter)
                        .then(_c => {
                            matched = _c;
                            return this.model.countDocuments()
                        })
                        .then(_t => {
                            totalCount = _t;
                        })
                }
                return promise;
            })
            .then(() => {
                if (metadata) {
                    resBody = {
                        _metadata: {
                            page,
                            count,
                            matched,
                            totalCount
                        },
                        data: docs
                    };
                } else {
                    resBody = docs;
                }
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(undefined, res, resBody, 200);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Okay(res, _docs))
                        } else {
                            return self.Okay(res, resVal)
                        }
                    }
                    return;
                }
                return self.Okay(res, resBody);
            })
            .catch(err => {
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(err, res);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Error(res, _docs ? docs : err))
                        } else {
                            return self.Error(res, resVal ? resVal : err)
                        }
                    }
                    return;
                }
                return self.Error(res, err);
            });
    },

    /**
     * Get a single document. The requested document id is read from the request parameters
     * by using the {@link CrudController#idName} property.
     * @param {IncomingMessage} req - The request message object the id is read from
     * @param {ServerResponse} res - The outgoing response object
     * @param {Object} options - The options to manipulate response before sending.
     * @returns {ServerResponse} A single document or NOT FOUND if no document has been found
     */
    _show: function (req, res, options) {
        var self = this;
        debugLogReq(req, this.logger);
        var reqParams = params.map(req);
        var select = reqParams['select'] ? reqParams.select.split(',') : []; //Comma seprated fileds list
        var query = this.model.findOne({
            '_id': reqParams['id'],
            '_metadata.deleted': false
        });
        if (select.length > 0) {
            query = query.select(select.join(' '));
        }
        return query.exec()
            .then((document) => {
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(undefined, res, document ? document : "", document ? 200 : 404);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Okay(res, _docs))
                        } else {
                            return self.Okay(res, resVal)
                        }
                    }
                    return;
                }
                if (!document) {
                    return self.NotFound(res);
                } else {
                    return self.Okay(res, self.getResponseObject(document));
                }

            })
            .catch(err => {
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(err, res);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Error(res, _docs ? docs : err))
                        } else {
                            return self.Error(res, resVal ? resVal : err)
                        }
                    }
                    return;
                }
                return self.Error(res, err);
            });

    },

    /**
     * Runs aggregation on a collection. The API need request body as aggregation body.
     * @param {IncomingMessage} req - The request message object
     * @param {ServerResponse} res - The outgoing response object the result is set to
     * @param {Object} options - The options to manipulate response before sending.
     * @returns {ServerResponse} Array of all documents for the {@link CrudController#model} model
     * or the empty Array if no documents have been found
     */
    _aggregate: function (req, res, options) {
        var self = this;
        debugLogReq(req, this.logger);
        let aggBody = req.body;
        let promise = Promise.resolve();
        try {
            let flag = validateAggregation(aggBody);
            if (!flag) promise = Promise.reject(new Error('Invalid key in aggregation body'));
        }
        catch (err) {
            promise = Promise.reject(err);
        }
        return promise.then(() => this.model.aggregate(aggBody))
            .then(documents => {
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(undefined, res, documents, 200);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Okay(res, _docs))
                        } else {
                            return self.Okay(res, resVal)
                        }
                    }
                    return;
                }
                return self.Okay(res, documents);
            })
            .catch(err => {
                if (options && options.resHandler && typeof options.resHandler == 'function') {
                    let resVal = options.resHandler(err, res);
                    if (!res.headersSent) {
                        if (resVal instanceof Promise) {
                            return resVal.then(_docs => self.Error(res, _docs ? docs : err))
                        } else {
                            return self.Error(res, resVal ? resVal : err)
                        }
                    }
                    return;
                }
                return self.Error(res, err);
            });
    },
    /**
     * Creates a new document in the DB.
     * @param {IncomingMessage} req - The request message object containing the json document data
     * @param {ServerResponse} res - The outgoing response object
     * @returns {ServerResponse} The response status 201 CREATED or an error response
     */
    _create: function (req, res) {
        var self = this;
        debugLogReq(req, this.logger);
        var payload = 'data';
        var reqParams = params.map(req);
        var upsert = reqParams['upsert'];
        var docIds = [];
        var body = params.map(req)[payload];
        var promise = Promise.resolve([]);

        // if (upsert) {
        //     if (Array.isArray(body)) {
        //         docIds = body.map(doc => doc._id);
        //         docIds = docIds.filter(docs => docs);
        //     }
        //     else if (typeof body == "object") {
        //         docIds.push(body._id)
        //     }
        //     promise = self.model.find({ "_id": { "$in": docIds } });
        // }

        let newDocuments = [];
        if (Array.isArray(body)) {
            newDocuments = body;
        } else {
            newDocuments.push(body);
        }
        const results = [];
        promise = newDocuments.reduce((prev, curr) => {
            return prev.then(async () => {
                let result, doc;
                if (upsert && curr._id) {
                    doc = await self.model.findOne({ "_id": curr._id });
                    if (doc) {
                        _.mergeWith(doc, curr, self._customizer);
                        Object.keys(doc).forEach(el => doc.markModified(el));
                    }
                }
                if (!doc) {
                    doc = new self.model(curr);
                }
                try {
                    result = await doc.save(req);
                    results.push({ statusCode: 200, message: result });
                    return;
                } catch (err) {
                    results.push({ statusCode: 400, message: { message: err.message } });
                    return;
                }
            });
        }, Promise.resolve(null));

        return promise.then(() => {
            const documents = results;
            var logObject = {
                'operation': 'Create',
                'user': req.user ? req.user.username : req.headers['masterName'],
                '_id': documents.filter(_d => _d.statusCode === 200).map(_d => _d.message._id),
                'timestamp': new Date()
            };
            self.logger.trace(JSON.stringify(logObject));
            if (documents.some(_d => _d.statusCode === 400)) {
                if (Array.isArray(body)) {
                    var result = documents.map(_doc => _doc.message);
                    // if (abortOnError && session) {
                    //     handleSession(session, true);
                    //     return res.status(400).json(result);
                    // }  else
                    if ((documents.every(_d => _d.statusCode === 400))) {
                        return res.status(400).json(result);
                    } else {
                        return res.status(207).json(result);
                    }
                } else {
                    return res.status(400).json(documents[0].message);
                }
            } else {
                if (Array.isArray(body)) {
                    // if (abortOnError && session) handleSession(session, false);
                    return self.Okay(res, self.getResponseObject(documents.map(_d => _d.message)));
                } else {
                    return self.Okay(res, self.getResponseObject(documents[0].message));
                }
            }
        })
            .catch(err => {
                return self.Error(res, err);
            });
    },
    _bulkShow: function (req, res) {
        var sort = {};
        debugLogReq(req, this.logger);
        var reqParams = params.map(req);
        var ids = reqParams['id'] ? reqParams['id'].split(',') : [];
        reqParams['sort'] ? reqParams.sort.split(',').map(el => sort[el] = 1) : null;
        var select = reqParams['select'] ? reqParams.select.split(',') : null;
        var query = {
            '_id': {
                '$in': ids
            },
            '_metadata.deleted': false
        };
        var self = this;
        var mq = this.model.find(query);
        if (select) {
            mq = mq.select(select.join(' '));
        }
        return mq.sort(sort).exec().then(result => self.Okay(res, result), err => this.Error(res, err));
    },
    _updateMapper: function (id, body, user, req) {
        var self = this;
        return new Promise((resolve, reject) => {
            self.model.findOne({
                '_id': id,
                '_metadata.deleted': false
            }, function (err, doc) {
                if (err) {
                    resolve({ status: 400, data: { message: err.message } });
                } else if (!doc) {
                    resolve({ status: 404, data: { message: 'Document not found' } });
                } else {
                    var oldValues = doc.toObject();
                    var updated = _.mergeWith(doc, body, self._customizer);
                    if (_.isEqual(JSON.parse(JSON.stringify(oldValues)), JSON.parse(JSON.stringify(updated)))) {
                        resolve({ status: 200, data: updated });
                        return;
                    }
                    updated = new self.model(updated);
                    Object.keys(body).forEach(el => updated.markModified(el));
                    updated._oldDoc = JSON.parse(JSON.stringify(oldValues));
                    updated.save(req, function (err) {
                        if (err) {
                            return resolve({ status: 400, data: { message: err.message } });
                        }
                        var logObject = {
                            'operation': 'Update',
                            'user': user,
                            'originalValues': oldValues,
                            '_id': doc._id,
                            'newValues': body,
                            'timestamp': new Date()
                        };
                        self.logger.trace(JSON.stringify(logObject));
                        resolve({ status: 200, data: updated });
                    });
                }
            });
        });
    },
    _bulkUpdate: function (req, res) {
        var reqParams = params.map(req);
        debugLogReq(req, this.logger);
        var body = reqParams['data']; //Actual transformation
        var selectFields = Object.keys(body);
        var self = this;
        selectFields.push('_id');
        var ids = reqParams['id'] ? reqParams['id'].split(',') : []; //Ids will be comma seperated ID list
        var user = req.user ? req.user.username : req.headers['masterName'];
        var promises = ids.map(id => self._updateMapper(id, body, user, req));
        var promise = Promise.all(promises).then(result => {
            const resultData = result.map(e => e.data);
            if (result && result.every(e => e.status == 200)) {
                res.json(resultData);
            } else if (result && result.every(e => e.status != 200)) {
                res.status(400).json(resultData);
            } else {
                res.status(207).json(resultData);
            }
            // self.logger.debug("Sending Response:: " + JSON.stringify(result));
        }, err => {
            self.Error(res, err);
        });
        return promise;
    },
    _bulkUpload: function (req, res) {
        try {
            debugLogReq(req, this.logger);
            let buffer = req.files.file[0].buffer.toString('utf8');
            let rows = buffer.split('\n');
            let keys = rows[0].split(',');
            let products = [];
            let self = this;
            rows.splice(0, 1);
            rows.forEach(el => {
                let values = el.split(',');
                values.length > 1 ? products.push(_.zipObject(keys, values)) : null;
            });
            return Promise.all(products.map(el => self._bulkPersist(el))).
                then(result => {
                    res.status(200).json(result);
                    // self.logger.debug("Sending Response:: " + JSON.stringify(result));
                });
        } catch (e) {
            res.status(400).json(e);
            // self.logger.debug("Sending Response:: " + JSON.stringify(e));
        }
    },
    _bulkPersist: function (el) {
        var self = this;
        return new Promise((res, rej) => {
            self.model.create(el, function (err, doc) {
                if (err)
                    res(err);
                else
                    res(doc);
            });
        });
    },
    /**
     * Updates an existing document in the DB. The requested document id is read from the
     * request parameters by using the {@link CrudController#idName} property.
     * @param {IncomingMessage} req - The request message object the id is read from
     * @param {ServerResponse} res - The outgoing response object
     * @params {String} in -  The Body payload location, if not specified, the parameter is assumed to be 'body'
     * @returns {ServerResponse} The updated document or NOT FOUND if no document has been found
     */
    _update: function (req, res) {
        var reqParams = params.map(req);
        debugLogReq(req, this.logger);
        var bodyIn = 'data';
        var body = reqParams[bodyIn];
        if (body._id) {
            delete req.body._id;
        }
        var self = this;
        var bodyData = _.omit(body, this.omit);
        let oldValues = null;
        let document = null;
        let updated = null;
        let resSentFlag = false;
        return this.model.findOne({
            '_id': reqParams['id'],
            '_metadata.deleted': false
        }).lean()
            .then(_document => {
                if (!_document) {
                    resSentFlag = true;
                    return self.NotFound(res);
                }
                oldValues = JSON.parse(JSON.stringify(_document));
                document = _document;
                updated = _.mergeWith(_document, bodyData, self._customizer);
                if (_.isEqual(JSON.parse(JSON.stringify(updated)), JSON.parse(JSON.stringify(oldValues)))) return;
                updated = new self.model(updated);
                updated.isNew = false;
                Object.keys(body).forEach(el => updated.markModified(el));
                updated._oldDoc = JSON.parse(JSON.stringify(oldValues));
                return updated.save(req);
            })
            .then(() => {
                if (resSentFlag) return;
                var logObject = {
                    'operation': 'Update',
                    'user': req.user ? req.user.username : req.headers['masterName'],
                    // 'originalValues': oldValues,
                    '_id': document._id,
                    // 'newValues': body,
                    'timestamp': new Date()
                };
                self.logger.trace(JSON.stringify(logObject));
                return self.Okay(res, self.getResponseObject(updated));
            })
            .catch(err => {
                self.Error(res, err);
            })
    },

    _customizer: function (objValue, srcValue) {
        if (_.isArray(objValue)) {
            return srcValue;
        }
    },



    /**
     * Deletes a document from the DB. The requested document id is read from the
     * request parameters by using the {@link CrudController#idName} property.
     * @param {IncomingMessage} req - The request message object the id is read from
     * @param {ServerResponse} res - The outgoing response object
     * @returns {ServerResponse} A NO CONTENT response or NOT FOUND if no document has
     * been found for the given id
     */
    _destroy: function (req, res) {
        var reqParams = params.map(req);
        debugLogReq(req, this.logger);
        var self = this;
        let document = null;
        return this.model.findOne({
            '_id': reqParams['id']
        })
            .then(doc => {
                if (!doc) {
                    return;
                }
                document = doc;
                // Set explicitly so deleteOne hooks can rely on this._req for
                // the genuine request object; Mongoose does not reliably
                // forward the argument passed to deleteOne() to hooks in the
                // same shape (unlike the removed remove() method).
                document._req = req;
                return doc.deleteOne(req);
            })
            .then(() => {
                var logObject = {
                    'operation': 'Destory',
                    'user': req.user ? req.user.username : req.headers['masterName'],
                    '_id': reqParams['id'],
                    'timestamp': new Date()
                };
                self.logger.trace(JSON.stringify(logObject));
                return self.Okay(res, {});
            })
            .catch(err => {
                return self.Error(res, err);
            })
    },
    _bulkDestroy: function (req, res) {
        let self = this;
        bulkRemove(self, req, res, "destroy");
    },
    _markAsDeleted: function (req, res) {
        var reqParams = params.map(req);
        debugLogReq(req, this.logger);
        var self = this;
        let document = null;
        return this.model.findOne({
            '_id': reqParams['id'],
            '_metadata.deleted': false
        })
            .then(doc => {
                if (!doc) {
                    return;
                }
                doc._metadata.deleted = true;
                document = JSON.parse(JSON.stringify(doc));
                return doc.save(req);
            })
            .then(() => {
                var logObject = {
                    'operation': 'Delete',
                    'user': req.user ? req.user.username : req.headers['masterName'],
                    '_id': document._id,
                    'timestamp': new Date()
                };
                self.logger.trace(JSON.stringify(logObject));
                return self.Okay(res, {});
            })
            .catch(err => {
                return self.Error(res, err);
            });
    },
    _bulkMarkAsDeleted: function (req, res) {
        let self = this;
        bulkRemove(self, req, res, "markAsDeleted");
    },
    _rucc: function (queryObject, callBack) {
        //rucc = Read Update Check Commit
        var self = this;
        debugLogReq(req, this.logger);
        return this.model.findOne({
            _id: queryObject['id'],
            '_metadata.deleted': false
        }).exec().then(result => {
            if (result) {
                var snapshot = result.toObject({
                    getters: false,
                    virtuals: false,
                    depopulate: true,
                });
                var newResult = callBack(result);
                if (newResult && typeof newResult.then === 'function') {
                    //newResult is a promise, resolve it and then update.
                    return newResult.then(res => {
                        self.model.findOneAndUpdate(snapshot, res, {
                            upsert: false,
                            runValidators: true
                        });
                    })
                        .exec()
                        .then(updated => {
                            if (!updated) {
                                self.__rucc(queryObject, callBack); //Re-do the transaction.
                            } else {
                                return updated;
                            }
                        });
                } else {
                    //newResult is a mongoose object
                    return self.model.findOneAndUpdate(snapshot, newResult, {
                        upsert: false,
                        runValidators: true
                    })
                        .exec()
                        .then(updated => {
                            if (!updated) {
                                self.___rucc(queryObject, callBack);
                            } else {
                                return updated;
                            }
                        });
                }
            } else {
                return null;
            }

        });
    },

    getResponseObject: function (obj) {
        return this.defaultReturn && obj[this.defaultReturn] || obj;
    }
};

CrudController.prototype = _.create(BaseController.prototype, CrudController.prototype);

/**
 * The CrudController for basic CRUD functionality on Mongoose models
 * @type {CrudController}
 */
exports = module.exports = CrudController;