#!/usr/bin/env node
/**
 * Reproduces OpenCode issue #45333 against the locally installed OpenCode.
 *
 * The harness starts three isolated processes:
 *   1. a dependency-free stdio MCP server exposing `example_ping`;
 *   2. an OpenAI-compatible mock provider that records every `tools[]` array;
 *   3. `opencode serve --standalone` in a throwaway workspace that points at both.
 *
 * It then drives the V2 session API reported in the issue
 * (`POST /api/session` + `POST /api/session/{id}/prompt`), waits for the agent
 * loop to become idle, and compares the MCP server state with the tools the
 * provider actually received.
 *
 * Exit codes: 0 harness completed (see verdict), 2 harness failed.
 */

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(HERE, 'evidence');
const KEEP = process.argv.includes('--keep');
const RUN_TIMEOUT_MS = 120_000;

const log = (message) => {
	process.stderr.write(`[repro] ${message}\n`);
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const freePort = () =>
	new Promise((resolvePort, rejectPort) => {
		const server = createServer();

		server.on('error', rejectPort);
		server.listen(0, '127.0.0.1', () => {
			const {port} = server.address();
			server.close(() => resolvePort(port));
		});
	});

const waitFor = async (predicate, {timeoutMs = 60_000, intervalMs = 100, label = 'condition'} = {}) => {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const value = await predicate();

		if (value) {
			return value;
		}

		await sleep(intervalMs);
	}

	throw new Error(`Timed out waiting for ${label}`);
};

const startProcess = (command, args, options) => {
	const child = spawn(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		...options,
	});

	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (data) => {
		stdout += data;
	});
	child.stderr.on('data', (data) => {
		stderr += data;
	});

	return {
		child,
		getStdout: () => stdout,
		getStderr: () => stderr,
		stop: () => {
			if (!child.killed) {
				child.kill('SIGTERM');
			}
		},
	};
};

const basicAuth = (password) => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const apiFetch = async (baseUrl, password, path, init = {}) => {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			authorization: basicAuth(password),
			'content-type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	let body;

	try {
		body = text === '' ? null : JSON.parse(text);
	} catch {
		body = text;
	}

	return {status: response.status, body};
};

const resolveOpenCode = () => {
	const override = process.env.OPENCODE_BIN;

	if (override) {
		return override;
	}

	return 'opencode';
};

const writeEvidence = (name, content) => {
	writeFileSync(join(EVIDENCE_DIR, name), content);
};

const redact = (text, workspacePath) => {
	let output = text;
	const paths = [...new Set([workspacePath, realpathSync(workspacePath)])].sort(
		(left, right) => right.length - left.length,
	);

	for (const path of paths) {
		output = output.split(path).join('<workspace>');
	}

	output = output.split(HERE).join('<repro-dir>');
	output = output.replace(/server password \S+/g, 'server password <redacted>');

	const home = process.env.HOME;

	if (home) {
		output = output.split(home).join('$HOME');
	}

	return output;
};

const main = async () => {
	const startedAt = new Date().toISOString();
	const workspace = mkdtempSync(join(tmpdir(), 'opencode-mcp-v2-repro-'));
	const xdgRoot = join(workspace, '.xdg');
	const requestLogPath = join(workspace, 'provider-requests.jsonl');
	const bodyLogPath = join(workspace, 'provider-bodies.jsonl');
	const handshakeMarkerPath = join(workspace, 'mcp-tools-listed.json');

	mkdirSync(join(workspace, '.xdg'), {recursive: true});
	mkdirSync(EVIDENCE_DIR, {recursive: true});
	writeFileSync(requestLogPath, '');

	const providerPort = await freePort();
	const serverPort = await freePort();
	const serverBaseUrl = `http://127.0.0.1:${serverPort}`;

	const projectConfig = {
		$schema: 'https://opencode.ai/config.json',
		model: 'mock/repro-probe',
		providers: {
			mock: {
				name: 'Repro mock provider',
				package: '@opencode/ai/providers/openai-compatible',
				settings: {baseURL: `http://127.0.0.1:${providerPort}/v1`},
				models: {
					'repro-probe': {
						modelID: 'repro-probe',
						name: 'Repro probe',
						capabilities: {tools: true, input: ['text'], output: ['text']},
						limit: {context: 32768, output: 4096},
					},
				},
			},
		},
		mcp: {
			servers: {
				reproping: {
					type: 'local',
					command: [process.execPath, join(HERE, 'mcp-server.mjs')],
					environment: {REPRO_HANDSHAKE_FILE: handshakeMarkerPath},
				},
			},
		},
	};

	const configText = `${JSON.stringify(projectConfig, null, '\t')}\n`;
	writeFileSync(join(workspace, 'opencode.jsonc'), configText);
	writeFileSync(
		join(workspace, 'AGENTS.md'),
		'This is a disposable reproduction workspace. Never modify files.\n',
	);

	// The installed 2.0.32 build sometimes ignores a project configuration
	// written immediately before launch. A short settle delay makes discovery
	// deterministic.
	await sleep(1500);

	const environment = {
		...process.env,
		XDG_CONFIG_HOME: join(xdgRoot, 'config'),
		XDG_DATA_HOME: join(xdgRoot, 'data'),
		XDG_CACHE_HOME: join(xdgRoot, 'cache'),
		XDG_STATE_HOME: join(xdgRoot, 'state'),
		OPENCODE_DB: join(xdgRoot, 'opencode.db'),
		MOCK_PROVIDER_PORT: String(providerPort),
		MOCK_PROVIDER_LOG: requestLogPath,
		MOCK_PROVIDER_BODY_LOG: bodyLogPath,
		MOCK_MCP_SERVER_NAME: 'reproping',
	};

	const provider = startProcess(process.execPath, [join(HERE, 'mock-provider.mjs')], {
		cwd: HERE,
		env: environment,
	});

	const opencode = startProcess(
		resolveOpenCode(),
		['serve', '--port', String(serverPort)],
		{cwd: workspace, env: environment},
	);

	const result = {
		issue: 'https://github.com/anomalyco/opencode/issues/45333',
		startedAt,
		opencodeVersion: null,
		workspace,
		providerBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
		serverBaseUrl,
		mcp: null,
		session: null,
		requests: [],
		verdict: 'inconclusive',
		reasons: [],
	};

	try {
		await waitFor(
			() => provider.getStdout().includes('{'),
			{label: 'mock provider startup'},
		);

		const ready = await waitFor(
			async () => {
				const auth = /server password (\S+)/.exec(opencode.getStdout());
				const listening = /server listening on (\S+)/.exec(opencode.getStdout());

				if (!auth || !listening) {
					return undefined;
				}

				const info = await apiFetch(listening[1], auth[1], '/api/info').catch(() => undefined);

				return info?.status === 200 ? {password: auth[1], baseUrl: listening[1], info: info.body} : undefined;
			},
			{label: 'OpenCode server startup'},
		);

		const {password, baseUrl, info} = ready;
		result.opencodeVersion = info?.version ?? null;
		result.serverBaseUrl = baseUrl;

		const mcpList = await waitFor(
			async () => {
				const listed = await apiFetch(baseUrl, password, '/api/mcp');
				const connected = (listed.body?.data ?? []).some(
					(entry) => entry?.name === 'reproping' && entry?.status?.status === 'connected',
				);

				return connected && existsSync(handshakeMarkerPath) ? listed : undefined;
			},
			{timeoutMs: 45_000, label: 'MCP server connection and catalog'},
		);
		result.mcp = mcpList.body;

		const handshake = JSON.parse(readFileSync(handshakeMarkerPath, 'utf8'));
		result.mcpCatalog = handshake;
		if (!handshake.tools?.includes('example_ping')) {
			result.reasons.push('MCP server catalog did not contain example_ping');
			throw new Error(result.reasons.at(-1));
		}

		const created = await apiFetch(baseUrl, password, '/api/session', {
			method: 'POST',
			body: JSON.stringify({
				title: 'MCP tool materialization repro',
				model: {providerID: 'mock', id: 'repro-probe'},
				location: {directory: workspace},
			}),
		});

		if (created.status !== 200) {
			throw new Error(`session.create failed: ${created.status} ${JSON.stringify(created.body)}`);
		}

		const sessionID = created.body?.data?.id ?? created.body?.id;
		if (!sessionID) {
			throw new Error(`session.create returned no id: ${JSON.stringify(created.body)}`);
		}

		result.session = {id: sessionID, created: created.body?.data ?? created.body};

		const prompted = await apiFetch(baseUrl, password, `/api/session/${sessionID}/prompt`, {
			method: 'POST',
			body: JSON.stringify({
				text: 'Call example_ping and show me the result. Call the tool, do not explain first.',
			}),
		});

		if (prompted.status !== 200) {
			throw new Error(`session.prompt failed: ${prompted.status} ${JSON.stringify(prompted.body)}`);
		}

		await waitFor(
			async () => {
				const waited = await apiFetch(
					baseUrl,
					password,
					`/api/experimental/session/${sessionID}/wait`,
					{method: 'POST'},
				).catch(() => ({status: 0}));

				return waited.status === 204;
			},
			{timeoutMs: RUN_TIMEOUT_MS, label: 'agent loop idle'},
		);

		const messages = await apiFetch(
			baseUrl,
			password,
			`/api/session/${sessionID}/message?order=asc`,
		);
		writeEvidence(
			'session-messages.json',
			redact(`${JSON.stringify(messages.body, null, '\t')}\n`, workspace),
		);

		result.assistantText = (messages.body?.data ?? [])
			.filter((message) => message?.type === 'assistant')
			.flatMap((message) => message.content ?? [])
			.filter((part) => part?.type === 'text')
			.map((part) => part.text)
			.join('\n');

		const requestLines = readFileSync(requestLogPath, 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '');
		result.requests = requestLines.map((line) => JSON.parse(line));

		if (result.requests.length === 0) {
			result.reasons.push('Mock provider received no chat-completion request');
			throw new Error(result.reasons.at(-1));
		}

		const pingPresent = result.requests.some((request) => request.pingToolPresent);
		const sawToolResult = result.requests.some((request) =>
			request.messageRoles.includes('tool'),
		);

		result.verdict = pingPresent ? 'not-reproduced' : 'reproduced';
		result.reasons.push(
			pingPresent
				? 'At least one provider request advertised an MCP ping tool.'
				: 'No provider request advertised the MCP ping tool, although the MCP server was connected and exposed it.',
		);
		result.reasons.push(
			sawToolResult
				? 'The agent loop executed the MCP tool.'
				: 'The agent loop never produced a tool result for the MCP tool.',
		);
	} catch (error) {
		result.harnessError = String(error);
		if (result.verdict !== 'reproduced') {
			result.verdict = 'inconclusive';
		}
	} finally {
		opencode.stop();
		provider.stop();
		await sleep(300);

		result.opencodeStdout = opencode.getStdout();
		result.opencodeStderr = opencode.getStderr();
		result.finishedAt = new Date().toISOString();
		result.keptWorkspace = KEEP;

		writeEvidence(
			'summary.json',
			redact(`${JSON.stringify(result, null, '\t')}\n`, workspace),
		);
		writeEvidence(
			'requests.jsonl',
			redact(
				result.requests.map((request) => JSON.stringify(request)).join('\n') +
					(result.requests.length > 0 ? '\n' : ''),
				workspace,
			),
		);
		writeEvidence(
			'opencode-server.log',
			redact(`${opencode.getStdout()}\n${opencode.getStderr()}\n`, workspace),
		);
		writeEvidence(
			'provider-requests.jsonl',
			redact(readFileSync(requestLogPath, 'utf8'), workspace),
		);
		writeEvidence('provider-bodies.jsonl', redact(readFileSync(bodyLogPath, 'utf8'), workspace));

		if (!KEEP) {
			rmSync(workspace, {recursive: true, force: true});
		}
	}

	const summary = {
		verdict: result.verdict,
		opencodeVersion: result.opencodeVersion,
		requests: result.requests.length,
		toolNamesSeen: [...new Set(result.requests.flatMap((request) => request.toolNames))],
		assistantText: result.assistantText ?? null,
		reasons: result.reasons,
		evidence: EVIDENCE_DIR,
		workspace: result.keptWorkspace ? result.workspace : null,
	};

	process.stdout.write(`${JSON.stringify(summary, null, '\t')}\n`);

	if (result.verdict === 'inconclusive') {
		process.exitCode = 2;
	}
};

await main();
