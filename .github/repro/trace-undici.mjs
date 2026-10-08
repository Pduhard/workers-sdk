import dc from "node:diagnostics_channel";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const out = process.env.TRACE_UNDICI_FILE;
const log = (msg) =>
	out && fs.appendFileSync(out, `${process.pid} ${performance.now().toFixed(1)} ${msg}\n`);

const sockets = new WeakMap();
let nextId = 1;
const info = (socket) => {
	let s = sockets.get(socket);
	if (!s) {
		s = { id: nextId++, born: performance.now(), lastDone: undefined, requests: 0 };
		sockets.set(socket, s);
	}
	return s;
};
const idle = (s) =>
	s.lastDone === undefined ? "fresh" : `${(performance.now() - s.lastDone).toFixed(1)}ms`;
const requestSocket = new WeakMap();

dc.subscribe("undici:client:connected", ({ socket, connectParams }) => {
	const s = info(socket);
	log(`connect sock=${s.id} ${connectParams.hostname}:${connectParams.port} local=${socket.localPort}`);
	socket.on("end", () => log(`peer-FIN sock=${s.id} idle=${idle(s)} reqs=${s.requests}`));
	socket.on("close", (hadError) => log(`close sock=${s.id} idle=${idle(s)} hadError=${hadError}`));
	socket.on("error", (e) => log(`sock-error sock=${s.id} idle=${idle(s)} ${e.code ?? e.message}`));
});

dc.subscribe("undici:client:sendHeaders", ({ request, socket }) => {
	const s = info(socket);
	s.requests++;
	requestSocket.set(request, s);
	log(`send sock=${s.id} #${s.requests} ${request.method} ${request.path.slice(0, 60)} idle=${idle(s)} age=${(performance.now() - s.born).toFixed(1)}ms`);
});

const done = ({ request }) => {
	const s = requestSocket.get(request);
	if (s) s.lastDone = performance.now();
};
dc.subscribe("undici:request:trailers", done);

dc.subscribe("undici:request:bodySent", ({ request }) => {
	const s = requestSocket.get(request);
	log(`bodySent sock=${s?.id} ${request.method} ${request.path.slice(0, 40)}`);
});

dc.subscribe("undici:request:headers", ({ request, response }) => {
	const s = requestSocket.get(request);
	const headers = response.headers.map(String);
	const connection = headers.findIndex((h) => h.toLowerCase() === "connection");
	log(`headers sock=${s?.id} ${request.method} ${request.path.slice(0, 40)} status=${response.statusCode} connection=${connection >= 0 ? headers[connection + 1] : "-"}`);
});

dc.subscribe("undici:request:error", ({ request, error }) => {
	const s = requestSocket.get(request);
	log(`REQUEST-ERROR sock=${s?.id} ${request.method} ${request.path.slice(0, 60)} ${error.code ?? ""} ${error.message}`);
});
