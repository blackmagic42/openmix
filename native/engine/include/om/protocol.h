// JSON protocol between the renderer's JS proxy (src/js/native-engine.js)
// and the engine (owner: host): the table of every command (name, route,
// reply), the parsing and validation of one message (or a batch array) into
// ParsedCommands (an RtCommand for audio-thread commands, values clamped
// like engine.js), and the builders of the events (reply, state, ...).
// Runs on the caller's thread (allocates). SPEC.md §3.3, §15.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "om/commands.h"
#include "om/json.h"
#include "om/om_state.h"

namespace om {

constexpr int kProtocolVersion = 2;

// Where a command runs (SPEC.md §3.3).
enum class Route : uint8_t {
  Audio = 0,   // queued to the audio thread as an RtCommand
  Inline = 1,  // executed at once on the caller's thread, in order with the audio commands (bounded work)
  Ops = 2,     // queued to the ops thread (devices, recordings): reply event
  Vst = 3,     // queued to the vst-ops thread (plugins): reply event
};
const char* routeName(Route r) noexcept;  // "audio", "inline", "ops", "vst"

struct CommandSpec {
  const char* name;  // JSON "cmd"
  Cmd cmd;
  Route route;
  bool deckScoped;   // needs "deck": 0..3
  bool replies;      // answers {"ev":"reply","id":...} when the message has an "id"
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
  EngineTime when = 0;    // "when" (engine clock), 0 = next block
  RtCommand rt;           // filled for audio-thread commands (route Audio)
  json::Value body;       // the whole message (control-side commands read their fields here)
};

// Parses and validates one message: a command object, or an array of
// command objects (a batch, applied in order). Audio-thread commands get a
// fully filled RtCommand (deck index checked, values clamped like engine.js,
// NaN / wrong types rejected). On error nothing is appended and *err says
// why: a batch is valid only as a whole.
bool parseCommands(std::string_view text, std::vector<ParsedCommand>& out, std::string* err);

// Number of RtCommands executing `pc` will push (audio command: 1; inline
// commands: their attach commands; ops / vst: 0). The core reserves this
// much queue room for a whole batch before running any of it (SPEC.md §3.3).
int queueCost(const ParsedCommand& pc) noexcept;

// ---- event builders --------------------------------------------------------------
std::string replyJson(int64_t id, bool ok, const json::Value& fields, std::string_view error = {});
std::string eventJson(std::string_view ev, const json::Value& fields);
// The periodic "state" event (SPEC.md §15.5).
std::string stateJson(const om_state& s);

}  // namespace om
