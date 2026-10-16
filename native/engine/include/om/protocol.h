// JSON protocol between the renderer's JS proxy and the engine (owner: host):
// the table of every command (name, thread, reply), parsing of one message
// into a ParsedCommand (an RtCommand for audio-thread commands) and builders
// for the events (reply, state, ...). Control thread only. SPEC.md §15.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "om/commands.h"
#include "om/json.h"
#include "om/state.h"

namespace om {

constexpr int kProtocolVersion = 1;

struct CommandSpec {
  const char* name;  // JSON "cmd"
  Cmd cmd;
  bool audio;        // queued to the audio thread as an RtCommand
  bool replies;      // always answers {"ev":"reply","id":...} (needs "id")
};

// Every command with a JSON name (internal commands have none).
const CommandSpec* commandSpecs(int* count) noexcept;
const CommandSpec* findCommandSpec(std::string_view name) noexcept;
const char* commandName(Cmd c) noexcept;  // nullptr for internal commands

struct ParsedCommand {
  const CommandSpec* spec = nullptr;
  uint32_t seq = 0;       // "seq" (monotonic per connection, 0 = none)
  int64_t id = -1;        // "id" (reply requested), -1 = none
  EngineTime at = 0;      // "at" (engine clock), 0 = none
  RtCommand rt;           // filled for audio-thread commands (spec->audio)
  json::Value body;       // the whole message (control-thread commands read their fields here)
};

// Parses and validates one message. Audio-thread commands get a fully filled
// RtCommand (deck index checked, values clamped like engine.js).
bool parseCommand(std::string_view text, ParsedCommand& out, std::string* err);

// ---- event builders --------------------------------------------------------------
std::string replyJson(int64_t id, bool ok, const json::Value& fields, std::string_view error = {});
std::string eventJson(std::string_view ev, const json::Value& fields);
// The periodic "state" event (SPEC.md §15.4).
std::string stateJson(const EngineStateRT& s);

}  // namespace om
