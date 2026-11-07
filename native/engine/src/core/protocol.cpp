// The JSON protocol (owner: host): the command table (complete — it IS the
// protocol of SPEC.md §15, with each command's route, §3.3), parsing and
// validation of messages into ParsedCommands with engine.js clamping, the
// queue cost of each command (atomic batches), and the event builders
// (reply, generic events, the "state" event built from om_state).
#include "om/protocol.h"

#include <cmath>
#include <cstring>

#include "om/interpolator.h"
#include "om/sync.h"

namespace om {

namespace {

// name, command, route (SPEC.md §3.3), needs "deck"?, replies when "id" is given?
constexpr Route A = Route::Audio;
constexpr Route I = Route::Inline;
constexpr Route O = Route::Ops;
constexpr Route V = Route::Vst;
const CommandSpec kSpecs[] = {
    // ---- control side ----
    {"hello", Cmd::Hello, I, false, true},
    {"engine.config", Cmd::EngineConfig, I, false, true},
    {"clock.ping", Cmd::ClockPing, I, false, false},  // always answers with "clock.pong"
    {"device.list", Cmd::DeviceList, O, false, true},
    {"device.open", Cmd::DeviceOpen, O, false, true},
    {"device.phones", Cmd::DevicePhones, O, false, true},
    {"device.close", Cmd::DeviceClose, O, false, true},
    {"device.status", Cmd::DeviceStatus, I, false, true},
    {"shutdown", Cmd::Shutdown, O, false, false},
    {"pcm.begin", Cmd::PcmBegin, I, false, true},
    {"pcm.abort", Cmd::PcmAbort, I, false, false},
    {"deck.load", Cmd::DeckLoad, I, true, true},
    {"deck.unload", Cmd::DeckUnload, I, true, false},
    {"deck.stems", Cmd::DeckStems, I, true, true},
    {"deck.grid", Cmd::DeckGrid, I, true, false},
    {"sampler.load", Cmd::SamplerLoad, I, false, true},
    {"sampler.clear", Cmd::SamplerClear, I, false, false},
    {"rec.start", Cmd::RecStart, O, false, true},
    {"rec.stop", Cmd::RecStop, O, false, true},
    {"rec.status", Cmd::RecStatus, I, false, true},
    {"rec.list", Cmd::RecList, O, false, true},
    {"vst.load", Cmd::VstLoad, V, true, true},
    {"vst.unload", Cmd::VstUnload, V, true, true},
    {"vst.editor", Cmd::VstEditor, V, true, true},
    {"vst.editorClose", Cmd::VstEditorClose, V, true, false},
    {"vst.getState", Cmd::VstGetState, V, true, true},
    {"vst.setState", Cmd::VstSetState, V, true, true},
    {"vst.status", Cmd::VstStatus, I, true, true},
    // ---- audio thread: mixer ----
    {"master.volume", Cmd::MasterVolume, A, false, false},
    {"master.filter", Cmd::MasterFilter, A, false, false},
    {"xf.set", Cmd::Crossfader, A, false, false},
    {"xf.sides", Cmd::XfSides, A, false, false},
    {"color.type", Cmd::ColorTypeSet, A, false, false},
    {"color.enabled", Cmd::ColorEnabled, A, false, false},
    {"deck.color", Cmd::DeckColor, A, true, false},
    {"deck.pfl", Cmd::DeckPfl, A, true, false},
    {"deck.volume", Cmd::DeckVolume, A, true, false},
    {"deck.trim", Cmd::DeckTrim, A, true, false},
    {"deck.eq", Cmd::DeckEq, A, true, false},
    {"deck.padDryHold", Cmd::DeckPadDryHold, A, true, false},
    {"fx.set", Cmd::FxSet, A, false, false},
    {"fx.assign", Cmd::FxAssign, A, false, false},
    {"fx.sends", Cmd::FxSends, A, false, false},
    {"fx.pad", Cmd::FxPad, A, true, false},
    {"sampler.play", Cmd::SamplerPlay, A, false, false},
    {"sampler.stop", Cmd::SamplerStop, A, false, false},
    {"vst.mix", Cmd::VstMix, A, true, false},
    // ---- audio thread: deck ----
    {"deck.play", Cmd::DeckPlay, A, true, false},
    {"deck.pause", Cmd::DeckPause, A, true, false},
    {"deck.seek", Cmd::DeckSeek, A, true, false},
    {"deck.cuePoint", Cmd::DeckCuePoint, A, true, false},
    {"deck.tempo", Cmd::DeckTempo, A, true, false},
    {"deck.key", Cmd::DeckKey, A, true, false},
    {"deck.keylock", Cmd::DeckKeylock, A, true, false},
    {"deck.loop", Cmd::DeckLoop, A, true, false},
    {"deck.loopExit", Cmd::DeckLoopExit, A, true, false},
    {"deck.loopBeats", Cmd::DeckLoopBeats, A, true, false},
    {"deck.roll", Cmd::DeckRoll, A, true, false},
    {"deck.rollMix", Cmd::DeckRollMix, A, true, false},
    {"deck.rollStop", Cmd::DeckRollStop, A, true, false},
    {"deck.scratch", Cmd::DeckScratch, A, true, false},
    {"deck.spin", Cmd::DeckSpin, A, true, false},
    {"deck.stemsOn", Cmd::DeckStemsOn, A, true, false},
    {"deck.stemGain", Cmd::DeckStemGain, A, true, false},
    {"deck.interp", Cmd::DeckInterp, A, true, false},
    {"deck.keylockRatio", Cmd::DeckKeylockRatio, A, true, false},
    {"grid.offset", Cmd::GridOffset, A, false, false},
    // ---- audio thread: sync ----
    {"sync.master", Cmd::SyncMaster, A, false, false},
    {"sync.jogHold", Cmd::SyncJogHold, A, false, false},
    {"sync.do", Cmd::SyncDo, A, true, false},  // answers with "sync.result"
    {"sync.reanchor", Cmd::SyncReanchor, A, true, false},
    {"sync.snap", Cmd::SyncSnap, A, true, false},  // answers with "sync.result"
    {"sync.arm", Cmd::SyncArm, A, true, false},
    {"sync.base", Cmd::SyncBase, A, true, false},
    {"sync.precision", Cmd::SyncPrecision, A, false, false},  // native precision refinements (off = engine.js parity)
    {"deck.padRoll", Cmd::DeckPadRoll, A, true, false},
};

using json::Value;

struct Ctx {
  const Value& b;
  std::string* err;
  const char* cmd;
  bool bad(const char* field, const char* why) {
    if (err) *err = std::string(cmd) + ": \"" + field + "\" " + why;
    return false;
  }
  // Required finite number.
  bool num(const char* k, double& out) {
    const Value& v = b[k];
    if (!v.isNumber() || !std::isfinite(v.asNumber(0))) return bad(k, "must be a finite number");
    out = v.asNumber(0);
    return true;
  }
  // Optional finite number (default when absent).
  bool numOpt(const char* k, double& out, double def) {
    if (!b.has(k)) {
      out = def;
      return true;
    }
    return num(k, out);
  }
  // Number or null (null -> NaN). Required.
  bool numOrNull(const char* k, double& out) {
    const Value& v = b[k];
    if (v.isNull() && b.has(k)) {
      out = kNaN;
      return true;
    }
    return num(k, out);
  }
  bool flag(const char* k, bool& out) {
    const Value& v = b[k];
    if (!v.isBool()) return bad(k, "must be a boolean");
    out = v.asBool();
    return true;
  }
  bool flagOpt(const char* k, bool& out, bool def) {
    if (!b.has(k)) {
      out = def;
      return true;
    }
    return flag(k, out);
  }
  bool name(const char* k, const char*& out) {
    const Value& v = b[k];
    if (!v.isString()) return bad(k, "must be a string");
    out = v.asString().c_str();
    return true;
  }
};

bool parseFxUnit(const std::string& s, FxUnitId& out) {
  if (s == "master") {
    out = masterUnit();
    return true;
  }
  if (s.size() == 3 && s.compare(0, 2, "fx") == 0 && s[2] >= '0' && s[2] < '0' + kNumFxUnits) {
    out = panelUnit(s[2] - '0');
    return true;
  }
  if (s.size() == 4 && s.compare(0, 3, "pad") == 0 && s[3] >= '0' && s[3] < '0' + kNumDecks) {
    out = padUnit(s[3] - '0');
    return true;
  }
  return false;
}

// Fills the payload of an audio-thread command (values clamped like engine.js).
bool fillPayload(ParsedCommand& pc, std::string* err) {
  RtCommand& rt = pc.rt;
  Ctx c{pc.body, err, pc.spec->name};
  double x = 0;
  bool on = false;
  const char* n = nullptr;
  switch (rt.type) {
    case Cmd::MasterVolume:
    case Cmd::DeckVolume:
      if (!c.num("v", x)) return false;
      rt.u.level.v = static_cast<float>(clampv(x, 0.0, 1.0));
      return true;
    case Cmd::Crossfader:
      if (!c.num("x", x)) return false;
      rt.u.level.v = static_cast<float>(clampv(x, 0.0, 1.0));
      return true;
    case Cmd::MasterFilter:
    case Cmd::DeckColor:
    case Cmd::DeckTrim:
      if (!c.num("v", x)) return false;
      rt.u.level.v = static_cast<float>(clampv(x, -1.0, 1.0));
      return true;
    case Cmd::XfSides: {
      const Value& s = pc.body["sides"];
      if (!s.isArray() || s.size() != kNumDecks) return c.bad("sides", "must be an array of 4 \"A\"/\"B\"");
      for (int d = 0; d < kNumDecks; d++) {
        const std::string& v = s.at(d).asString();
        if (v != "A" && v != "B") return c.bad("sides", "must be an array of 4 \"A\"/\"B\"");
        rt.u.xfSides.sides[d] = static_cast<uint8_t>(v == "A" ? XfSide::A : XfSide::B);
      }
      return true;
    }
    case Cmd::ColorTypeSet: {
      ColorType t;
      if (!c.name("type", n) || !colorTypeFromName(n, t)) return c.bad("type", "is not a Color FX type");
      rt.u.color.type = static_cast<uint8_t>(t);
      return true;
    }
    case Cmd::ColorEnabled:
    case Cmd::DeckPfl:
    case Cmd::DeckKeylock:
    case Cmd::DeckStemsOn:
    case Cmd::SyncJogHold:
    case Cmd::SyncArm:
    case Cmd::SyncPrecision:
      if (!c.flag("on", on)) return false;
      rt.u.flag.on = on ? 1 : 0;
      return true;
    case Cmd::DeckEq: {
      EqBand band;
      if (!c.name("band", n) || !eqBandFromName(n, band)) return c.bad("band", "must be low, mid or high");
      if (!c.num("v", x)) return false;
      rt.u.eq.band = static_cast<uint8_t>(band);
      rt.u.eq.v = static_cast<float>(clampv(x, -1.0, 1.0));
      return true;
    }
    case Cmd::DeckPadDryHold:
      if (!c.numOrNull("dry", x)) return false;
      rt.u.padDry.dry = std::isnan(x) ? NAN : static_cast<float>(clampv(x, 0.0, 1.0));
      return true;
    case Cmd::FxSet: {
      FxUnitId id;
      if (!pc.body["unit"].isString() || !parseFxUnit(pc.body["unit"].asString(), id))
        return c.bad("unit", "must be fx0..fx3, pad0..pad3 or master");
      rt.u.fx.unit = id;
      rt.u.fx.mask = 0;
      if (pc.body.has("type")) {
        FxType t;
        if (!c.name("type", n) || !fxTypeFromName(n, t)) return c.bad("type", "is not an FX type");
        rt.u.fx.type = static_cast<uint8_t>(t);
        rt.u.fx.mask |= kFxType;
      }
      if (pc.body.has("enabled")) {
        if (!c.flag("enabled", on)) return false;
        rt.u.fx.enabled = on ? 1 : 0;
        rt.u.fx.mask |= kFxEnabled;
      }
      if (pc.body.has("level")) {
        if (!c.num("level", x)) return false;
        rt.u.fx.level = static_cast<float>(clampv(x, 0.0, 1.0));
        rt.u.fx.mask |= kFxLevel;
      }
      if (pc.body.has("beats")) {
        if (!c.num("beats", x) || !(x > 0)) return c.bad("beats", "must be > 0");
        rt.u.fx.beats = static_cast<float>(x);
        rt.u.fx.mask |= kFxBeats;
      }
      return true;  // no field = ensure the unit exists (engine.js ensureMasterFx)
    }
    case Cmd::FxAssign:
    case Cmd::FxSends: {
      // fx.assign: the LIVE matrix (required); fx.sends: the updateFxSends
      // latch, with an optional matrix applied first (SPEC.md §10.3).
      rt.u.fxSends.bits = 0;
      rt.u.fxSends.hasAssign = 0;
      if (rt.type == Cmd::FxSends && !pc.body.has("assign")) return true;
      const Value& a = pc.body["assign"];
      if (!a.isArray() || a.size() != kNumFxUnits) return c.bad("assign", "must be a 4x4 array of booleans");
      uint16_t bits = 0;
      for (int u = 0; u < kNumFxUnits; u++) {
        const Value& row = a.at(u);
        if (!row.isArray() || row.size() != kNumDecks) return c.bad("assign", "must be a 4x4 array of booleans");
        for (int d = 0; d < kNumDecks; d++)
          if (row.at(d).asBool(false)) bits = static_cast<uint16_t>(bits | (1u << (u * 4 + d)));
      }
      rt.u.fxSends.bits = bits;
      rt.u.fxSends.hasAssign = 1;
      return true;
    }
    case Cmd::FxPad: {
      const Value& p = pc.body["preset"];
      if (p.isNull()) {
        rt.u.fxPad.on = 0;
        return true;
      }
      if (!p.isObject()) return c.bad("preset", "must be an object or null");
      FxType t;
      if (!fxTypeFromName(p["type"].asString().c_str(), t)) return c.bad("preset.type", "is not an FX type");
      const double beats = p["beats"].asNumber(0.5);
      const double level = p["level"].asNumber(0.0);
      if (!(beats > 0) || !std::isfinite(level)) return c.bad("preset", "needs beats > 0 and a level");
      rt.u.fxPad.on = 1;
      rt.u.fxPad.type = static_cast<uint8_t>(t);
      rt.u.fxPad.beats = static_cast<float>(beats);
      rt.u.fxPad.level = static_cast<float>(clampv(level, 0.0, 1.0));
      return true;
    }
    case Cmd::SamplerPlay: {
      double slot = 0, voice = 0, gain = 1;
      if (!c.num("slot", slot) || !c.num("voice", voice) || !c.numOpt("gain", gain, 1.0)) return false;
      if (slot < 0 || slot >= kMaxSamplerSlots) return c.bad("slot", "out of range");
      rt.u.sampler.slot = static_cast<int32_t>(slot);
      rt.u.sampler.voice = static_cast<uint32_t>(voice);
      rt.u.sampler.gain = static_cast<float>(clampv(gain, 0.0, 4.0));
      return true;
    }
    case Cmd::SamplerStop: {
      double voice = 0;
      if (!c.num("voice", voice)) return false;
      rt.u.sampler.voice = static_cast<uint32_t>(voice);
      return true;
    }
    case Cmd::VstMix:
      if (!c.num("mix", x)) return false;
      rt.u.vstMix.mix = static_cast<float>(clampv(x, 0.0, 1.0));
      return true;
    case Cmd::DeckPlay:
    case Cmd::DeckPause:
    case Cmd::DeckLoopExit:
    case Cmd::SyncDo:
    case Cmd::SyncReanchor:
      return true;
    case Cmd::DeckSeek:
    case Cmd::DeckCuePoint:
      if (!c.num("t", x)) return false;
      rt.u.seek.t = clampv(x, -kPreRollSec, 1e7);
      return true;
    case Cmd::DeckTempo:
      if (!c.num("r", x)) return false;
      rt.u.tempo.r = clampv(x, kTempoMin, kTempoMax);
      return true;
    case Cmd::DeckKey:
      if (!c.num("semi", x)) return false;
      rt.u.key.semi = static_cast<int32_t>(clampv(jsRound(x), double(kKeyMin), double(kKeyMax)));
      return true;
    case Cmd::DeckLoop: {
      double s = 0, e = 0;
      if (!c.num("start", s) || !c.num("end", e)) return false;
      rt.u.loop.start = s;
      rt.u.loop.end = e;
      return true;
    }
    case Cmd::DeckLoopBeats:
      if (!c.numOrNull("beats", x)) return false;
      rt.u.loopBeats.beats = x;
      return true;
    case Cmd::DeckRoll: {
      double beats = 0, mix = 1;
      if (!c.num("beats", beats) || !(beats > 0)) return c.bad("beats", "must be > 0");
      if (!c.numOpt("mix", mix, 1.0)) return false;
      rt.u.roll.beats = beats;
      rt.u.roll.mix = clampv(mix, 0.0, 1.0);
      return true;
    }
    case Cmd::DeckRollMix:
      if (!c.num("mix", x)) return false;
      rt.u.roll.mix = clampv(x, 0.0, 1.0);
      return true;
    case Cmd::DeckRollStop:
      if (!c.flagOpt("immediate", on, false)) return false;
      rt.u.roll.immediate = on ? 1 : 0;
      return true;
    case Cmd::DeckPadRoll: {
      double beats = 0, mix = 1;
      if (!c.numOrNull("beats", beats)) return false;
      if (!c.numOpt("mix", mix, 1.0)) return false;
      rt.u.roll.beats = std::isnan(beats) ? 0.0 : beats;
      rt.u.roll.mix = clampv(mix, 0.0, 1.0);
      return true;
    }
    case Cmd::DeckScratch: {
      ScratchPhase ph;
      if (!c.name("phase", n) || !scratchPhaseFromName(n, ph)) return c.bad("phase", "must be start, move or end");
      rt.u.scratch.phase = static_cast<uint8_t>(ph);
      rt.u.scratch.t = 0;
      if (ph == ScratchPhase::Move) {
        if (!c.num("t", x)) return false;
        rt.u.scratch.t = clampv(x, -kPreRollSec, 1e7);
      }
      return true;
    }
    case Cmd::DeckSpin: {
      SpinKind k;
      if (!c.name("kind", n) || !spinKindFromName(n, k)) return c.bad("kind", "must be vbrake, backspin or none");
      rt.u.spin.kind = static_cast<uint8_t>(k);
      return true;
    }
    case Cmd::DeckStemGain: {
      Stem s;
      double tau = 0.01;
      if (!c.name("stem", n) || !stemFromName(n, s)) return c.bad("stem", "must be vocals, drums, bass or other");
      if (!c.num("v", x) || !c.numOpt("tau", tau, 0.01)) return false;
      rt.u.stemGain.stem = static_cast<uint8_t>(s);
      rt.u.stemGain.gain = static_cast<float>(clampv(x, 0.0, 2.0));
      rt.u.stemGain.tau = static_cast<float>(clampv(tau, 0.0, 10.0));
      return true;
    }
    case Cmd::DeckInterp: {
      if (!c.name("quality", n)) return false;
      InterpQuality q;
      if (std::strcmp(n, "linear") == 0) q = InterpQuality::Linear;
      else if (std::strcmp(n, "hermite") == 0) q = InterpQuality::Hermite4;
      else if (std::strcmp(n, "sinc") == 0) q = InterpQuality::Sinc16;
      else return c.bad("quality", "must be linear, hermite or sinc");
      rt.u.interp.quality = static_cast<uint8_t>(q);
      return true;
    }
    case Cmd::DeckKeylockRatio: {
      if (!c.name("mode", n)) return false;
      if (std::strcmp(n, "worklet") == 0) rt.u.keylockRatio.mode = 0;
      else if (std::strcmp(n, "input") == 0) rt.u.keylockRatio.mode = 1;
      else return c.bad("mode", "must be worklet or input");
      return true;
    }
    case Cmd::GridOffset:
      if (!c.num("sec", x)) return false;
      rt.u.gridOffset.sec = clampv(x, -1.0, 1.0);
      return true;
    case Cmd::SyncMaster: {
      const Value& v = pc.body["deck"];
      if (v.isNull()) {
        rt.u.master.idx = -1;
        return true;
      }
      if (!v.isNumber() || v.asNumber(-1) < 0 || v.asNumber(-1) >= kNumDecks) return c.bad("deck", "must be 0..3 or null");
      rt.u.master.idx = static_cast<int32_t>(v.asNumber(0));
      return true;
    }
    case Cmd::SyncSnap:
      if (!c.numOpt("maxErr", x, 0.06)) return false;
      rt.u.snap.maxErr = clampv(x, 0.0, 0.5);
      return true;
    case Cmd::SyncBase: {
      rt.u.syncBase.mask = 0;
      rt.u.syncBase.base = kNaN;
      rt.u.syncBase.ref = kNaN;
      rt.u.syncBase.pllCorr = 0;
      if (pc.body.has("base")) {
        if (!c.numOrNull("base", x)) return false;
        rt.u.syncBase.base = x;
        rt.u.syncBase.mask |= SyncBaseWrite::kBase;
      }
      if (pc.body.has("ref")) {
        if (!c.numOrNull("ref", x)) return false;
        rt.u.syncBase.ref = x;
        rt.u.syncBase.mask |= SyncBaseWrite::kRef;
      }
      if (pc.body.has("pllCorr")) {
        if (!c.num("pllCorr", x)) return false;
        rt.u.syncBase.pllCorr = clampv(x, -0.1, 0.1);
        rt.u.syncBase.mask |= SyncBaseWrite::kPllCorr;
      }
      return true;
    }
    default:
      if (err) *err = std::string(pc.spec->name) + ": no payload parser";
      return false;
  }
}

bool parseOne(const Value& msg, ParsedCommand& pc, std::string* err) {
  if (!msg.isObject()) {
    if (err) *err = "a command must be a JSON object";
    return false;
  }
  const Value& name = msg["cmd"];
  if (!name.isString()) {
    if (err) *err = "missing \"cmd\"";
    return false;
  }
  pc.spec = findCommandSpec(name.asString());
  if (!pc.spec) {
    if (err) *err = "unknown command \"" + name.asString() + "\"";
    return false;
  }
  const Value& seq = msg["seq"];
  if (seq.isNumber()) {
    const double s = seq.asNumber(0);
    if (!(s >= 0 && s <= 4294967295.0)) {
      if (err) *err = "\"seq\" out of range";
      return false;
    }
    pc.seq = static_cast<uint32_t>(s);
  }
  if (msg["id"].isNumber()) pc.id = static_cast<int64_t>(msg["id"].asNumber(-1));
  if (msg["at"].isNumber() && std::isfinite(msg["at"].asNumber(0))) pc.at = msg["at"].asNumber(0);
  if (msg["when"].isNumber() && std::isfinite(msg["when"].asNumber(0))) pc.when = msg["when"].asNumber(0);
  int deck = -1;
  if (pc.spec->deckScoped) {
    const Value& d = msg["deck"];
    const double dv = d.asNumber(-1);
    if (!d.isNumber() || dv < 0 || dv >= kNumDecks || dv != std::floor(dv)) {
      if (err) *err = std::string(pc.spec->name) + ": \"deck\" must be 0..3";
      return false;
    }
    deck = static_cast<int>(dv);
  }
  // Recordings are created by name in <dataDir>/recordings: the renderer
  // never gives a path (SPEC.md §15.6).
  if (pc.spec->cmd == Cmd::RecStart) {
    if (msg.has("path")) {
      if (err) *err = "rec.start: \"path\" is not accepted (give a \"name\")";
      return false;
    }
    if (msg.has("name") && !msg["name"].isString()) {
      if (err) *err = "rec.start: \"name\" must be a string";
      return false;
    }
  }
  pc.body = msg;
  pc.rt = RtCommand();
  pc.rt.type = pc.spec->cmd;
  pc.rt.deck = static_cast<int8_t>(deck);
  pc.rt.seq = pc.seq;
  pc.rt.at = pc.at;
  pc.rt.when = pc.when;
  if (msg.has("when")) pc.rt.flags |= kRtWhen;  // excluded from ack, confirmed by "applied"
  if (pc.spec->route == Route::Audio) return fillPayload(pc, err);
  return true;
}

// ---- state event builder helpers -------------------------------------------------
struct W {
  std::string s;
  bool first = true;
  void key(const char* k) {
    if (!first) s += ',';
    first = false;
    s += '"';
    s += k;
    s += "\":";
  }
  void num(const char* k, double v) {
    key(k);
    json::appendNumber(s, v);  // NaN -> null
  }
  void boolean(const char* k, bool v) {
    key(k);
    s += v ? "true" : "false";
  }
  void idx(const char* k, int v) {
    key(k);
    if (v < 0) s += "null";
    else s += std::to_string(v);
  }
  template <class F>
  void obj(const char* k, F f) {
    key(k);
    s += '{';
    first = true;
    f();
    s += '}';
    first = false;
  }
  template <class T>
  void arr(const char* k, const T* v, int n, bool asBool = false) {
    key(k);
    s += '[';
    for (int i = 0; i < n; i++) {
      if (i) s += ',';
      if (asBool) s += v[i] ? "true" : "false";
      else json::appendNumber(s, static_cast<double>(v[i]));
    }
    s += ']';
  }
};

}  // namespace

const char* routeName(Route r) noexcept {
  switch (r) {
    case Route::Audio: return "audio";
    case Route::Inline: return "inline";
    case Route::Ops: return "ops";
    case Route::Vst: return "vst";
  }
  return "audio";
}

int queueCost(const ParsedCommand& pc) noexcept {
  if (!pc.spec) return 0;
  if (pc.spec->route == Route::Audio) return 1;
  switch (pc.spec->cmd) {
    case Cmd::DeckLoad:    // reset, stems detach, track, grid
    case Cmd::DeckUnload:  // reset, stems, grid, track detach
      return 4;
    case Cmd::DeckStems:
    case Cmd::DeckGrid:
    case Cmd::SamplerLoad:
    case Cmd::SamplerClear:
      return 1;
    case Cmd::Hello:
      return pc.body["reset"].asBool(false) ? 1 : 0;  // EngineReset
    case Cmd::EngineConfig:
      return pc.body.has("vstDeadline") ? 1 : 0;      // SetVstDeadline
    default:
      return 0;
  }
}

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

bool parseCommands(std::string_view text, std::vector<ParsedCommand>& out, std::string* err) {
  Value root;
  if (!json::parse(text, root, err)) return false;
  std::vector<ParsedCommand> tmp;
  if (root.isArray()) {
    tmp.resize(root.size());
    for (size_t i = 0; i < root.size(); i++)
      if (!parseOne(root.at(i), tmp[i], err)) return false;
  } else {
    tmp.resize(1);
    if (!parseOne(root, tmp[0], err)) return false;
  }
  for (auto& pc : tmp) out.push_back(std::move(pc));
  return true;
}

std::string replyJson(int64_t id, bool ok, const json::Value& fields, std::string_view error) {
  Value v = Value::object();
  v.set("ev", Value::string("reply"));
  v.set("id", Value::number(static_cast<double>(id)));
  v.set("ok", Value::boolean(ok));
  if (!error.empty()) v.set("error", Value::string(std::string(error)));
  if (fields.isObject()) {
    for (size_t i = 0; i < fields.keys().size(); i++) v.set(fields.keys()[i], fields.items()[i]);
  }
  return json::stringify(v);
}

std::string eventJson(std::string_view ev, const json::Value& fields) {
  Value v = Value::object();
  v.set("ev", Value::string(std::string(ev)));
  if (fields.isObject()) {
    for (size_t i = 0; i < fields.keys().size(); i++) v.set(fields.keys()[i], fields.items()[i]);
  }
  return json::stringify(v);
}

std::string stateJson(const om_state& st) {
  W w;
  w.s.reserve(6144);
  w.s += '{';
  w.key("ev");
  w.s += "\"state\"";
  w.num("t", st.t);
  w.num("ack", st.ack);
  w.num("epoch", st.epoch);
  w.num("block", static_cast<double>(st.block));
  w.key("decks");
  w.s += '[';
  for (int d = 0; d < OM_NUM_DECKS; d++) {
    const om_deck_state& k = st.decks[d];
    if (d) w.s += ',';
    w.s += '{';
    w.first = true;
    w.num("loadId", k.load_id);
    w.boolean("loaded", k.loaded);
    w.boolean("playing", k.playing);
    w.boolean("armed", k.armed);
    w.num("pos", k.pos);
    w.num("rate", k.rate);
    w.num("tempo", k.tempo);
    w.num("seg", k.seg);
    w.num("anchorT", k.anchor_t);
    w.num("anchorPos", k.anchor_pos);
    w.num("endedCount", k.ended_count);
    w.num("startWaitMs", k.start_wait_ms);
    w.num("duration", k.duration);
    w.num("ready", k.pcm_ready);
    w.boolean("looping", k.looping);
    w.num("loopStart", k.loop_start);
    w.num("loopEnd", k.loop_end);
    w.num("loopBeats", k.loop_beats);
    w.num("cuePoint", k.cue_point);
    w.num("keyShift", k.key_shift);
    w.boolean("keylock", k.keylock);
    w.boolean("routedW", k.routed_wsola);
    w.num("procLat", k.proc_latency);
    w.boolean("stemsReady", k.stems_ready);
    w.boolean("stemsOn", k.stems_on);
    w.arr("stemGains", k.stem_gains, OM_NUM_STEMS);
    w.boolean("rolling", k.rolling);
    w.num("rollBeats", k.roll_beats);
    w.boolean("scratching", k.scratching);
    w.boolean("spinning", k.spinning);
    w.boolean("settled", k.settled);
    w.num("endedAt", k.ended_at);
    w.obj("insert", [&] {
      w.num("state", k.insert_state);
      w.num("late", k.insert_late);
    });
    w.num("peak", k.peak);
    w.num("rms", k.rms);
    w.num("dry", k.dry);
    w.s += '}';
  }
  w.s += ']';
  w.first = false;
  w.obj("sync", [&] {
    const om_sync_state& y = st.sync;
    w.idx("masterIdx", y.master_idx);
    w.idx("autoMasterIdx", y.auto_master_idx);
    w.boolean("jogHold", y.jog_hold);
    w.arr("synced", y.synced, OM_NUM_DECKS, true);
    w.arr("calibrated", y.calibrated, OM_NUM_DECKS, true);
    w.arr("syncBase", y.sync_base, OM_NUM_DECKS);
    w.arr("syncRef", y.sync_ref, OM_NUM_DECKS);
    w.arr("pllCorr", y.pll_corr, OM_NUM_DECKS);
    w.arr("beatDur", y.beat_dur, OM_NUM_DECKS);
  });
  w.obj("mixer", [&] {
    const om_mixer_state& m = st.mixer;
    w.num("masterPeak", m.master_peak);
    w.num("masterRms", m.master_rms);
    w.num("cuePeak", m.cue_peak);
    w.num("gr", m.gain_reduction_db);
    w.num("dryComp", m.dry_comp);
    w.num("masterWet", m.master_wet);
    w.arr("fxWet", m.fx_wet, OM_NUM_FX_UNITS);
    w.arr("padWet", m.pad_wet, OM_NUM_DECKS);
    w.num("samplerDropped", m.sampler_dropped);
  });
  w.obj("device", [&] {
    const om_device_state& v = st.device;
    w.num("mode", v.mode);
    w.num("rate", v.sample_rate);
    w.num("channels", v.channels);
    w.num("period", v.period_frames);
    w.num("latency", v.output_latency);
    w.num("jitterMs", v.present_jitter_ms);
    w.boolean("cueRouted", v.cue_routed);
    w.boolean("phones", v.phones_active);
    w.boolean("recording", v.recording);
    w.boolean("lost", v.lost);
    w.boolean("fellBack", v.fell_back);
    w.num("periodSteps", v.period_steps);
    w.boolean("throttlingOff", v.throttling_off);
    w.num("load", v.load);
    w.num("maxLoad", v.max_load);
    w.num("xruns", static_cast<double>(v.xruns));
  });
  w.obj("health", [&] {
    const om_health_state& h = st.health;
    w.num("rtAllocs", static_cast<double>(h.rt_allocs));
    w.num("rtFrees", static_cast<double>(h.rt_frees));
    w.num("pluginAllocs", static_cast<double>(h.plugin_allocs));
    w.num("batchesRejected", h.batches_rejected);
    w.num("eventsLost", h.events_lost);
    w.num("retiredBacklog", h.retired_backlog);
    w.num("retiredLost", h.retired_lost);
    w.num("pendingFull", h.pending_full);
    w.num("stalls", h.stalls);
  });
  w.num("pcmBytes", static_cast<double>(st.pcm_bytes));
  w.s += '}';
  return std::move(w.s);
}

}  // namespace om
