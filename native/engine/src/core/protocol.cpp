// The JSON protocol: the command table (complete — it IS the protocol of
// SPEC.md §15.2), message parsing and event builders (owner: host).
// SKELETON: parseCommand() and the builders are TODO.
#include <cstring>

#include "om/protocol.h"

namespace om {

namespace {

// name, command, audio thread?, always replies?
const CommandSpec kSpecs[] = {
    // ---- control thread ----
    {"hello", Cmd::Hello, false, true},
    {"engine.config", Cmd::EngineConfig, false, false},
    {"device.list", Cmd::DeviceList, false, true},
    {"device.open", Cmd::DeviceOpen, false, true},
    {"device.phones", Cmd::DevicePhones, false, true},
    {"device.close", Cmd::DeviceClose, false, false},
    {"clock.ping", Cmd::ClockPing, false, false},
    {"shutdown", Cmd::Shutdown, false, false},
    {"deck.preload", Cmd::DeckPreload, false, false},
    {"deck.load", Cmd::DeckLoad, false, false},
    {"deck.loadPcm", Cmd::DeckLoadPcm, false, false},
    {"deck.cancelLoad", Cmd::DeckCancelLoad, false, false},
    {"deck.grid", Cmd::DeckGrid, false, false},
    {"deck.stems", Cmd::DeckStems, false, false},
    {"sampler.load", Cmd::SamplerLoad, false, true},
    {"sampler.clear", Cmd::SamplerClear, false, false},
    {"rec.start", Cmd::RecStart, false, true},
    {"rec.stop", Cmd::RecStop, false, true},
    {"vst.scan", Cmd::VstScan, false, true},
    {"vst.load", Cmd::VstLoad, false, true},
    {"vst.unload", Cmd::VstUnload, false, true},
    {"vst.editor", Cmd::VstEditor, false, true},
    {"vst.editorClose", Cmd::VstEditorClose, false, false},
    {"vst.getState", Cmd::VstGetState, false, true},
    {"vst.setState", Cmd::VstSetState, false, true},
    {"vst.status", Cmd::VstStatus, false, true},
    // ---- audio thread: mixer ----
    {"master.volume", Cmd::MasterVolume, true, false},
    {"master.filter", Cmd::MasterFilter, true, false},
    {"xf.set", Cmd::Crossfader, true, false},
    {"xf.sides", Cmd::XfSides, true, false},
    {"color.type", Cmd::ColorTypeSet, true, false},
    {"color.enabled", Cmd::ColorEnabled, true, false},
    {"deck.color", Cmd::DeckColor, true, false},
    {"deck.pfl", Cmd::DeckPfl, true, false},
    {"deck.volume", Cmd::DeckVolume, true, false},
    {"deck.trim", Cmd::DeckTrim, true, false},
    {"deck.eq", Cmd::DeckEq, true, false},
    {"deck.padDryHold", Cmd::DeckPadDryHold, true, false},
    // ---- audio thread: deck ----
    {"deck.unload", Cmd::DeckUnload, true, false},
    {"deck.play", Cmd::DeckPlay, true, false},
    {"deck.pause", Cmd::DeckPause, true, false},
    {"deck.seek", Cmd::DeckSeek, true, false},
    {"deck.cueButton", Cmd::DeckCueButton, true, false},
    {"deck.cuePoint", Cmd::DeckCuePoint, true, false},
    {"deck.tempo", Cmd::DeckTempo, true, false},
    {"deck.key", Cmd::DeckKey, true, false},
    {"deck.keylock", Cmd::DeckKeylock, true, false},
    {"deck.loop", Cmd::DeckLoop, true, false},
    {"deck.loopExit", Cmd::DeckLoopExit, true, false},
    {"deck.loopBeats", Cmd::DeckLoopBeats, true, false},
    {"deck.roll", Cmd::DeckRoll, true, false},
    {"deck.rollMix", Cmd::DeckRollMix, true, false},
    {"deck.rollStop", Cmd::DeckRollStop, true, false},
    {"deck.padRoll", Cmd::DeckPadRoll, true, false},
    {"deck.slip", Cmd::DeckSlip, true, false},
    {"deck.scratch", Cmd::DeckScratch, true, false},
    {"deck.spin", Cmd::DeckSpin, true, false},
    {"deck.stemsOn", Cmd::DeckStemsOn, true, false},
    {"deck.stemGain", Cmd::DeckStemGain, true, false},
    {"grid.globalOffset", Cmd::GridGlobalOffset, true, false},
    // ---- audio thread: sync ----
    {"sync.master", Cmd::SyncMaster, true, false},
    {"sync.jogHold", Cmd::SyncJogHold, true, false},
    {"sync.do", Cmd::SyncDo, true, true},
    {"sync.reanchor", Cmd::SyncReanchor, true, false},
    {"sync.snap", Cmd::SyncSnap, true, true},
    {"sync.arm", Cmd::SyncArm, true, false},
    {"sync.base", Cmd::SyncBase, true, false},
    // ---- audio thread: fx / sampler / vst ----
    {"fx.set", Cmd::FxSet, true, false},
    {"fx.assign", Cmd::FxAssign, true, false},
    {"fx.pad", Cmd::FxPad, true, false},
    {"sampler.play", Cmd::SamplerPlay, true, false},
    {"sampler.stop", Cmd::SamplerStop, true, false},
    {"vst.mix", Cmd::VstMix, true, false},
};

}  // namespace

const CommandSpec* commandSpecs(int* count) noexcept {
  if (count) *count = static_cast<int>(sizeof(kSpecs) / sizeof(kSpecs[0]));
  return kSpecs;
}

const CommandSpec* findCommandSpec(std::string_view name) noexcept {
  for (const auto& s : kSpecs) {
    if (name == s.name) return &s;
  }
  return nullptr;
}

const char* commandName(Cmd c) noexcept {
  for (const auto& s : kSpecs) {
    if (s.cmd == c) return s.name;
  }
  return nullptr;
}

bool parseCommand(std::string_view, ParsedCommand& out, std::string* err) {
  out = ParsedCommand();
  if (err) *err = "protocol parser not implemented yet";  // TODO(host)
  return false;
}

std::string replyJson(int64_t, bool, const json::Value&, std::string_view) { return "{}"; }  // TODO(host)
std::string eventJson(std::string_view, const json::Value&) { return "{}"; }                // TODO(host)
std::string stateJson(const EngineStateRT&) { return "{}"; }                                // TODO(host)

}  // namespace om
