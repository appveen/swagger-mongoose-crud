'use strict';
// Drives the real controller methods against a running MongoDB.
//   MONGO_URL=mongodb://localhost:27017/crud-test npm run test:db
// Runs against whichever Mongoose is installed (6.5.1 through 9).
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { SMCrud } = require('../');

const url = process.env.MONGO_URL;
const skip = url ? false : 'set MONGO_URL to run the database tests';
const unique = Date.now().toString(36);

test.before(async () => { if (url) await mongoose.connect(url); });
test.after(async () => {
	if (!url) return;
	await mongoose.connection.db.dropDatabase();
	await mongoose.disconnect();
});

const makeCrud = (name) => {
	const schema = new mongoose.Schema({
		name: String,
		age: Number,
		_metadata: {
			deleted: { type: Boolean, default: false },
			lastUpdated: { type: Date, default: Date.now },
			version: { document: { type: Number, default: 0 } }
		}
	});
	return new SMCrud(schema, name + unique, { collectionName: name + unique });
};
const mkRes = () => ({
	statusCode: 200, body: undefined, headersSent: false, // express defaults to 200
	status(c) { this.statusCode = c; return this; },
	json(b) { this.body = b; this.headersSent = true; return this; },
	send(b) { this.body = b; this.headersSent = true; return this; }
});
const mkReq = (o = {}) => Object.assign({ query: {}, params: {}, body: {}, headers: {}, originalUrl: '/t', method: 'GET' }, o);
const seed = (crud, docs) => crud.model.insertMany(docs.map(d => Object.assign({ _metadata: { deleted: false, version: { document: 0 } } }, d)));

test('a model built with SMCrud can be saved and the save hook runs to completion', { skip }, async () => {
	const crud = makeCrud('hook');
	const doc = await new crud.model({ name: 'a', _metadata: { version: { document: 0 } } }).save();
	assert.strictEqual(doc._metadata.version.document, 1);
	doc.name = 'b';
	const again = await doc.save();
	assert.strictEqual(again._metadata.version.document, 2);
});

test('create stores the document', { skip }, async () => {
	const crud = makeCrud('create');
	const res = mkRes();
	await crud.create(mkReq({ body: { name: 'created', age: 3 } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(res.body.name, 'created');
	assert.strictEqual(await crud.model.countDocuments({ name: 'created' }), 1);
});

test('count returns the number of matching documents', { skip }, async () => {
	const crud = makeCrud('count');
	await seed(crud, [{ name: 'x', age: 1 }, { name: 'x', age: 2 }, { name: 'y', age: 3 }]);
	const res = mkRes();
	await crud.count(mkReq({ query: { filter: JSON.stringify({ name: 'x' }) } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(res.body, 2);
});

test('index with metadata=true returns matched and total counts', { skip }, async () => {
	const crud = makeCrud('index');
	await seed(crud, [{ name: 'x' }, { name: 'x' }, { name: 'y' }]);
	const res = mkRes();
	await crud.index(mkReq({ query: { filter: JSON.stringify({ name: 'x' }), metadata: 'true' } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(res.body._metadata.matched, 2);
	assert.strictEqual(res.body._metadata.totalCount, 3);
	assert.strictEqual(res.body.data.length, 2);
});

test('destroy removes the document', { skip }, async () => {
	const crud = makeCrud('destroy');
	const [d] = await seed(crud, [{ name: 'gone' }]);
	const res = mkRes();
	await crud.destroy(mkReq({ params: { id: String(d._id) } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(await crud.model.findById(d._id), null);
});

test('bulkDestroy removes every listed document', { skip }, async () => {
	const crud = makeCrud('bulkdel');
	const docs = await seed(crud, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
	const res = mkRes();
	await crud.bulkDestroy(mkReq({ params: { id: docs.slice(0, 2).map(d => d._id).join(',') } }), res);
	await new Promise(r => setTimeout(r, 200));
	assert.strictEqual(await crud.model.countDocuments({}), 1);
});

test('markAsDeleted flags the document instead of removing it', { skip }, async () => {
	const crud = makeCrud('soft');
	const [d] = await seed(crud, [{ name: 'soft' }]);
	const res = mkRes();
	await crud.markAsDeleted(mkReq({ params: { id: String(d._id) } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual((await crud.model.findById(d._id))._metadata.deleted, true);
});

test('bulkUpdate updates every listed document and reports a missing one as 404', { skip }, async () => {
	const crud = makeCrud('bulkupd');
	const docs = await seed(crud, [{ name: 'a', age: 1 }, { name: 'b', age: 2 }]);
	const ghost = new mongoose.Types.ObjectId();
	const res = mkRes();
	await crud.bulkUpdate(mkReq({ params: { id: [docs[0]._id, docs[1]._id, ghost].join(',') }, body: { age: 50 } }), res);
	assert.strictEqual(res.statusCode, 207);
	assert.strictEqual(res.body.length, 3);
	assert.deepStrictEqual(res.body.map(b => b.message).filter(Boolean), ['Document not found']);
	assert.strictEqual(await crud.model.countDocuments({ age: 50 }), 2);
});

test('bulkUpdate with all documents found answers 200', { skip }, async () => {
	const crud = makeCrud('bulkok');
	const docs = await seed(crud, [{ name: 'a', age: 1 }, { name: 'b', age: 2 }]);
	const res = mkRes();
	await crud.bulkUpdate(mkReq({ params: { id: docs.map(d => d._id).join(',') }, body: { age: 7 } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(await crud.model.countDocuments({ age: 7 }), 2);
});

test('bulkUpload creates a document per CSV row and returns the created documents', { skip }, async () => {
	const crud = makeCrud('upload');
	const csv = 'name,age\nrow1,10\nrow2,20\n';
	const res = mkRes();
	await crud.bulkUpload(mkReq({ files: { file: [{ buffer: Buffer.from(csv) }] } }), res);
	assert.strictEqual(res.statusCode, 200);
	assert.strictEqual(res.body.length, 2);
	assert.strictEqual(await crud.model.countDocuments({}), 2);
});
