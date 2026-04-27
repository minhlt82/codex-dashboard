#!/usr/bin/env node
// Codex Session Dashboard — v3: per-call message breakdown
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Tiktoken } = require('js-tiktoken/lite');
const o200k_base = require('js-tiktoken/ranks/o200k_base');

const PORT = process.env.PORT || 3456;
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// Initialize tokenizer (o200k_base — latest OpenAI BPE encoding, closest available approximation)
const enc = new Tiktoken(o200k_base);

// ─── JSONL Parser v3 ─────────────────────────────────────────────────────

function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  let meta = null;
  let threadName = null;
  let lastTimestamp = null;
  let firstTimestamp = null;

  // Per-turn tracking
  const turns = [];
  let currentTurn = null;
  let prevCumulativeTokens = null;

  // Aggregate
  let totalToolCalls = 0;
  const toolStats = {};
  const filesAccessed = new Set();

  // Per-API-call tracking: group events between token_count markers
  // Each "call" = one LLM API round-trip
  let currentCall = null;
  const startNewCall = () => {
    currentCall = {
      messages: [],   // { role, text, charLen }
      toolCalls: [],  // { name, callId, command, parsed, exitCode, durationMs }
      toolOutputs: [], // { callId, outputLen, tokenCount }
      reasoning: [],
      tokenSnapshot: null,
    };
  };
  startNewCall();

  // Map of exec_command_end by call_id
  const execEndMap = {};
  // Global map of function_call_output by call_id (outputs arrive AFTER token_count)
  const globalToolOutputMap = {};
  let latestSysContext = '';

  // First pass: build execEndMap + globalToolOutputMap
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'event_msg' && obj.payload?.type === 'exec_command_end') {
        execEndMap[obj.payload.call_id] = obj.payload;
      } else if (obj.type === 'response_item' && obj.payload?.type === 'function_call_output') {
        const p = obj.payload;
        const output = p.output || '';
        let tkCount = null;
        const m = output.match(/Original token count:\s*(\d+)/);
        if (m) tkCount = parseInt(m[1]);
        globalToolOutputMap[p.call_id] = { callId: p.call_id, outputLen: output.length, tokenCount: tkCount };
      }
    } catch {}
  }

  // Second pass: build timeline
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const t = obj.type;
      const p = obj.payload || {};
      const ts = obj.timestamp;

      if (!firstTimestamp && ts) firstTimestamp = ts;
      if (ts) lastTimestamp = ts;

      if (t === 'session_meta') {
        meta = {
          id: p.id, timestamp: p.timestamp, cwd: p.cwd,
          originator: p.originator, cliVersion: p.cli_version,
          source: p.source, modelProvider: p.model_provider,
        };

      } else if (t === 'event_msg') {
        const msgType = p.type;

        if (msgType === 'thread_name_updated') {
          threadName = p.thread_name;

        } else if (msgType === 'user_message') {
          // Carry over pre-turn messages (system prompt, initial user context)
          const preTurnMsgs = currentCall.messages.length > 0 ? [...currentCall.messages] : [];

          if (currentTurn) turns.push(currentTurn);
          currentTurn = {
            turnNum: turns.length + 1,
            userMessage: (p.message || '').substring(0, 200).trim(),
            timestamp: ts,
            calls: [],
            agentMessages: [],
          };
          startNewCall();
          // Merge pre-turn messages into first call of this turn
          currentCall.messages = preTurnMsgs.concat(currentCall.messages);

        } else if (msgType === 'token_count' && p.info) {
          const total = p.info.total_token_usage;
          const last = p.info.last_token_usage;
          const snap = {
            cumulative: { ...total },
            perCall: { ...last },
            contextWindow: p.info.model_context_window,
            rateLimits: p.rate_limits,
          };
          if (prevCumulativeTokens) {
            snap.delta = {
              input: total.input_tokens - prevCumulativeTokens.input_tokens,
              output: total.output_tokens - prevCumulativeTokens.output_tokens,
              reasoning: total.reasoning_output_tokens - prevCumulativeTokens.reasoning_output_tokens,
              cached: total.cached_input_tokens - prevCumulativeTokens.cached_input_tokens,
              total: total.total_tokens - prevCumulativeTokens.total_tokens,
            };
          }
          prevCumulativeTokens = { ...total };

          // Mark current call with this snapshot
          currentCall.tokenSnapshot = snap;
          if (currentTurn) currentTurn.calls.push(currentCall);
          startNewCall();

        } else if (msgType === 'agent_message') {
          if (currentTurn) currentTurn.agentMessages.push((p.message || '').substring(0, 300));

        } else if (msgType === 'exec_command_end') {
          // Already captured in execEndMap, processed via function_call
        }

      } else if (t === 'turn_context') {
        latestSysContext = p.developer_instructions || '';

      } else if (t === 'response_item') {
        if (p.type === 'message') {
          const role = p.role || 'unknown';
          const content = p.content || [];
          let fullText = '';
          for (const c of content) {
            const t = typeof c === 'string' ? c : (c?.text || '');
            fullText += t;
          }
          let tokenLen = 0;
          try { tokenLen = enc.encode(fullText).length; } catch { tokenLen = Math.round(fullText.length / 4); }
          currentCall.messages.push({ role, text: fullText, charLen: fullText.length, tokenLen });

        } else if (p.type === 'reasoning') {
          const content = p.content || [];
          let text = '';
          for (const c of content) {
            const t = typeof c === 'string' ? c : (c?.text || '');
            if (t) { text = t.substring(0, 100); break; }
          }
          currentCall.reasoning.push(text);

        } else if (p.type === 'function_call') {
          const execEnd = execEndMap[p.call_id];
          let cmdInfo = null;
          let displayCmd = '';
          let exitCode = null;
          let durationMs = null;

          if (execEnd) {
            const parsed = execEnd.parsed_cmd;
            if (Array.isArray(parsed) && parsed.length > 0) {
              const pc = parsed[0];
              cmdInfo = { type: pc.type || 'unknown', cmd: (pc.cmd || '').substring(0, 200), name: pc.name || null, path: pc.path || null };
              if (pc.path) filesAccessed.add(pc.path);
              displayCmd = cmdInfo.cmd;
            }
            if (!displayCmd) {
              const rawCmd = Array.isArray(execEnd.command) ? execEnd.command.slice(-1)[0] : String(execEnd.command || '');
              displayCmd = rawCmd.substring(0, 200);
            }
            exitCode = execEnd.exit_code;
            const dur = execEnd.duration;
            durationMs = dur ? (dur.secs * 1000 + Math.round((dur.nanos || 0) / 1e6)) : null;

            const toolType = cmdInfo?.type || 'unknown';
            if (!toolStats[toolType]) toolStats[toolType] = { count: 0, files: [] };
            toolStats[toolType].count++;
            if (cmdInfo?.path) toolStats[toolType].files.push(cmdInfo.path);
          }

          totalToolCalls++;
          currentCall.toolCalls.push({
            name: p.name, callId: p.call_id,
            command: displayCmd, parsed: cmdInfo,
            exitCode, durationMs,
          });

        } else if (p.type === 'function_call_output') {
          const output = p.output || '';
          // Extract "Original token count: N" if present
          let tkCount = null;
          const m = output.match(/Original token count:\s*(\d+)/);
          if (m) tkCount = parseInt(m[1]);

          currentCall.toolOutputs.push({
            callId: p.call_id,
            outputLen: output.length,
            tokenCount: tkCount,
          });
        }
      }
    } catch { /* skip */ }
  }
  if (currentTurn) turns.push(currentTurn);

  // Build turn summaries
  const turnSummaries = turns.map(turn => ({
    turnNum: turn.turnNum,
    userMessage: turn.userMessage,
    timestamp: turn.timestamp,
    agentMessages: turn.agentMessages,
    calls: turn.calls.map(call => {
      // Categorize messages
      const systemMsgs = call.messages.filter(m => m.role === 'developer');
      const userMsgs = call.messages.filter(m => m.role === 'user');
      const assistantMsgs = call.messages.filter(m => m.role === 'assistant');

      // Match tool outputs from global map (outputs arrive after token_count)
      const toolCallsEnriched = call.toolCalls.map(tc => {
        const out = globalToolOutputMap[tc.callId];
        return {
          command: tc.command,
          type: tc.parsed?.type || 'unknown',
          name: tc.parsed?.name || tc.name,
          path: tc.parsed?.path || null,
          exitCode: tc.exitCode,
          durationMs: tc.durationMs,
          outputLen: out?.outputLen || null,
          outputTokens: out?.tokenCount || null,
        };
      });

      return {
        messages: {
          system: systemMsgs.map(m => ({ charLen: m.charLen, tokenLen: m.tokenLen, preview: m.text })),
          user: userMsgs.map(m => ({ charLen: m.charLen, tokenLen: m.tokenLen, preview: m.text })),
          assistant: assistantMsgs.map(m => ({ charLen: m.charLen, tokenLen: m.tokenLen, preview: m.text })),
        },
        reasoning: call.reasoning,
        toolCalls: toolCallsEnriched,
        tokens: call.tokenSnapshot ? {
          cumulative: call.tokenSnapshot.cumulative,
          perCall: call.tokenSnapshot.perCall,
          contextWindow: call.tokenSnapshot.contextWindow,
          pct: ((call.tokenSnapshot.perCall.input_tokens / call.tokenSnapshot.contextWindow) * 100).toFixed(1),
        } : null,
      };
    }),
  }));

  const latestTurnRaw = turns[turns.length - 1];
  const latestCallRaw = latestTurnRaw?.calls?.[latestTurnRaw.calls.length - 1];

  // Track peak context usage across all calls (context compaction resets current but peak stays)
  let peakInput = 0;
  for (const turn of turns) {
    for (const call of turn.calls) {
      const inp = call.tokenSnapshot?.perCall?.input_tokens || 0;
      if (inp > peakInput) peakInput = inp;
    }
  }

  for (const key of Object.keys(toolStats)) {
    toolStats[key].files = [...new Set(toolStats[key].files)].slice(0, 20);
  }

  let breakdown = { system: 0, memory: 0, skills: 0, messages: 0 };
  if (latestTurnRaw) {
    // Accumulate system text from turn_context + all developer-role messages
    let sysTxt = latestSysContext || '';
    try {
      for (const t of turns) {
        for (const c of t.calls) {
          for (const m of c.messages) {
            if (m.role === 'developer' || m.role === 'system') sysTxt += (m.text || '');
          }
        }
      }
    } catch {}

    // Tokenize XML-tagged blocks with real encoder
    const countTokens = (text) => {
      try { return enc.encode(text).length; } catch { return Math.round(text.length / 4); }
    };

    // Extract matched blocks and tokenize each category
    let skillsTokens = 0, memTokens = 0;
    const extractBlocks = (tag) => {
      const res = sysTxt.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'ig'));
      return res || [];
    };

    for (const tag of ['skills', 'identity', 'guidelines', 'communication_style']) {
      for (const block of extractBlocks(tag)) skillsTokens += countTokens(block);
    }
    for (const tag of ['artifacts', 'knowledge_item', 'persistent_context', 'user_information', 'ephemeral_message']) {
      for (const block of extractBlocks(tag)) memTokens += countTokens(block);
    }

    breakdown.skills = skillsTokens;
    breakdown.system = Math.max(0, countTokens(sysTxt) - memTokens - skillsTokens);

    // Memory = XML-tagged context blocks + all tool outputs injected into context
    // Use real token counts from JSONL ("Original token count: N") when available
    let toolTokens = 0;
    for (const call of Object.values(globalToolOutputMap)) {
      if (call.tokenCount != null && call.tokenCount > 0) {
        toolTokens += call.tokenCount; // Actual tokens from API
      } else {
        toolTokens += Math.round((call.outputLen || 0) / 4); // Fallback estimate
      }
    }
    breakdown.memory = memTokens + toolTokens;

    // Messages = remaining input tokens after subtracting system/skills/memory
    const totalInput = latestCallRaw?.tokenSnapshot?.cumulative?.input_tokens || 0;
    if (totalInput > 0) {
      breakdown.messages = Math.max(0, totalInput - breakdown.memory - breakdown.skills - breakdown.system);
    }
  }

  return {
    file: path.basename(filePath),
    meta, threadName: threadName || (turns.length > 0 ? turns[0].userMessage.substring(0, 60) : 'Untitled'),
    totalTurns: turns.length, totalToolCalls,
    firstTimestamp, lastTimestamp,
    tokens: latestCallRaw?.tokenSnapshot ? {
      input: latestCallRaw.tokenSnapshot.cumulative.input_tokens,
      cached: latestCallRaw.tokenSnapshot.cumulative.cached_input_tokens,
      output: latestCallRaw.tokenSnapshot.cumulative.output_tokens,
      reasoning: latestCallRaw.tokenSnapshot.cumulative.reasoning_output_tokens,
      total: latestCallRaw.tokenSnapshot.cumulative.total_tokens,
      contextWindow: latestCallRaw.tokenSnapshot.contextWindow,
      currentInput: latestCallRaw.tokenSnapshot.perCall?.input_tokens || 0,
      peakInput: peakInput,
    } : null,
    rateLimits: latestCallRaw?.tokenSnapshot?.rateLimits || null,
    turns: turnSummaries, toolStats,
    filesAccessed: [...filesAccessed].slice(0, 50),
    contextTimeline: turns.flatMap(turn => turn.calls.map(c => c.tokenSnapshot?.cumulative?.total_tokens).filter(Boolean)),
    contextBreakdown: breakdown,
  };
}

function discoverSessions() {
  const sessions = [];
  try {
    const walkDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(full);
        else if (e.name.endsWith('.jsonl')) sessions.push(full);
      }
    };
    walkDir(SESSIONS_DIR);
  } catch {}
  sessions.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
  return sessions;
}

// Cache
const parseCache = new Map();
function getSessionData(filePath) {
  const stat = fs.statSync(filePath);
  const cached = parseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const data = parseSessionFile(filePath);
  parseCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

// API
function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/sessions') {
    const files = discoverSessions();
    const sessions = files.map(f => {
      try {
        const d = getSessionData(f);
        return { file: d.file, meta: d.meta, threadName: d.threadName, totalTurns: d.totalTurns, totalToolCalls: d.totalToolCalls, firstTimestamp: d.firstTimestamp, lastTimestamp: d.lastTimestamp, tokens: d.tokens, rateLimits: d.rateLimits, contextTimeline: d.contextTimeline, toolStats: d.toolStats, contextBreakdown: d.contextBreakdown };
      } catch { return null; }
    }).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  } else if (url.pathname === '/api/session') {
    const file = url.searchParams.get('file');
    if (!file) { res.writeHead(400); res.end('{"error":"missing file"}'); return; }
    const files = discoverSessions();
    const match = files.find(f => path.basename(f) === file);
    if (!match) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
    try {
      const data = getSessionData(match);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  } else { res.writeHead(404); res.end('Not found'); }
}

function serveHtml(req, res) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) handleApi(req, res);
  else serveHtml(req, res);
});
server.listen(PORT, () => console.log(`\n  🚀 Codex Dashboard → http://localhost:${PORT}\n  📂 ${SESSIONS_DIR}\n`));
