// Minimal JSON DOM of the engine protocol (owner: host): RFC 8259 parser
// (objects, arrays, strings with escapes and surrogate pairs, numbers,
// literals; depth-limited), compact serializer with round-trip doubles
// (NaN / Inf written as null). Library om_json (the core and the tests);
// never used on the audio thread. SPEC.md §15.1.
#include "om/json.h"

#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace om {
namespace json {

namespace {
const Value& nullValue() {
  static const Value v;
  return v;
}
const std::string& emptyString() {
  static const std::string s;
  return s;
}
}  // namespace

Value Value::boolean(bool b) {
  Value v;
  v.type_ = Type::Bool;
  v.b_ = b;
  return v;
}
Value Value::number(double n) {
  Value v;
  v.type_ = Type::Number;
  v.n_ = n;
  return v;
}
Value Value::string(std::string s) {
  Value v;
  v.type_ = Type::String;
  v.s_ = std::move(s);
  return v;
}
Value Value::array() {
  Value v;
  v.type_ = Type::Array;
  return v;
}
Value Value::object() {
  Value v;
  v.type_ = Type::Object;
  return v;
}

bool Value::asBool(bool def) const noexcept { return type_ == Type::Bool ? b_ : def; }
double Value::asNumber(double def) const noexcept { return type_ == Type::Number ? n_ : def; }
const std::string& Value::asString() const noexcept { return type_ == Type::String ? s_ : emptyString(); }

const Value& Value::operator[](std::string_view key) const noexcept {
  if (type_ != Type::Object) return nullValue();
  for (size_t i = 0; i < keys_.size(); i++) {
    if (keys_[i] == key) return items_[i];
  }
  return nullValue();
}

bool Value::has(std::string_view key) const noexcept {
  if (type_ != Type::Object) return false;
  for (const auto& k : keys_) {
    if (k == key) return true;
  }
  return false;
}

Value& Value::set(std::string key, Value v) {
  if (type_ != Type::Object) *this = object();
  for (size_t i = 0; i < keys_.size(); i++) {
    if (keys_[i] == key) {
      items_[i] = std::move(v);
      return *this;
    }
  }
  keys_.push_back(std::move(key));
  items_.push_back(std::move(v));
  return *this;
}

const Value& Value::at(size_t i) const noexcept {
  if (type_ != Type::Array || i >= items_.size()) return nullValue();
  return items_[i];
}

size_t Value::size() const noexcept {
  return (type_ == Type::Array || type_ == Type::Object) ? items_.size() : 0;
}

Value& Value::push(Value v) {
  if (type_ != Type::Array) *this = array();
  items_.push_back(std::move(v));
  return *this;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
namespace {

constexpr int kMaxDepth = 64;

struct Parser {
  std::string_view s;
  size_t i = 0;
  std::string err;

  bool fail(const char* what) {
    if (err.empty()) err = std::string(what) + " at offset " + std::to_string(i);
    return false;
  }
  void ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  }
  bool lit(const char* word) {
    const size_t n = std::strlen(word);
    if (s.substr(i, n) != word) return false;
    i += n;
    return true;
  }
  static void putUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }
  bool hex4(uint32_t& v) {
    if (i + 4 > s.size()) return fail("truncated \\u escape");
    v = 0;
    for (int k = 0; k < 4; k++) {
      const char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
      else return fail("bad hex digit");
    }
    return true;
  }
  bool str(std::string& out) {
    if (i >= s.size() || s[i] != '"') return fail("expected string");
    i++;
    while (i < s.size()) {
      const char c = s[i++];
      if (c == '"') return true;
      if (static_cast<unsigned char>(c) < 0x20) return fail("control character in string");
      if (c != '\\') {
        out += c;
        continue;
      }
      if (i >= s.size()) break;
      const char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            uint32_t lo;
            if (i + 6 > s.size() || s[i] != '\\' || s[i + 1] != 'u') return fail("lone high surrogate");
            i += 2;
            if (!hex4(lo)) return false;
            if (lo < 0xDC00 || lo > 0xDFFF) return fail("bad low surrogate");
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            return fail("lone low surrogate");
          }
          putUtf8(out, cp);
          break;
        }
        default:
          return fail("bad escape");
      }
    }
    return fail("unterminated string");
  }
  bool num(double& out) {
    const size_t start = i;
    if (i < s.size() && s[i] == '-') i++;
    if (i >= s.size()) return fail("bad number");
    if (s[i] == '0') {
      i++;
    } else if (s[i] >= '1' && s[i] <= '9') {
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
    } else {
      return fail("bad number");
    }
    if (i < s.size() && s[i] == '.') {
      i++;
      if (i >= s.size() || s[i] < '0' || s[i] > '9') return fail("bad fraction");
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
    }
    if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
      i++;
      if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
      if (i >= s.size() || s[i] < '0' || s[i] > '9') return fail("bad exponent");
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
    }
    const auto r = std::from_chars(s.data() + start, s.data() + i, out);
    if (r.ec != std::errc() && r.ec != std::errc::result_out_of_range) return fail("bad number");
    return true;
  }
  bool value(Value& out, int depth) {
    if (depth > kMaxDepth) return fail("nesting too deep");
    ws();
    if (i >= s.size()) return fail("unexpected end");
    const char c = s[i];
    if (c == '{') {
      i++;
      out = Value::object();
      ws();
      if (i < s.size() && s[i] == '}') {
        i++;
        return true;
      }
      for (;;) {
        ws();
        std::string key;
        if (!str(key)) return false;
        ws();
        if (i >= s.size() || s[i] != ':') return fail("expected ':'");
        i++;
        Value v;
        if (!value(v, depth + 1)) return false;
        out.set(std::move(key), std::move(v));
        ws();
        if (i < s.size() && s[i] == ',') {
          i++;
          continue;
        }
        if (i < s.size() && s[i] == '}') {
          i++;
          return true;
        }
        return fail("expected ',' or '}'");
      }
    }
    if (c == '[') {
      i++;
      out = Value::array();
      ws();
      if (i < s.size() && s[i] == ']') {
        i++;
        return true;
      }
      for (;;) {
        Value v;
        if (!value(v, depth + 1)) return false;
        out.push(std::move(v));
        ws();
        if (i < s.size() && s[i] == ',') {
          i++;
          continue;
        }
        if (i < s.size() && s[i] == ']') {
          i++;
          return true;
        }
        return fail("expected ',' or ']'");
      }
    }
    if (c == '"') {
      std::string v;
      if (!str(v)) return false;
      out = Value::string(std::move(v));
      return true;
    }
    if (lit("true")) {
      out = Value::boolean(true);
      return true;
    }
    if (lit("false")) {
      out = Value::boolean(false);
      return true;
    }
    if (lit("null")) {
      out = Value();
      return true;
    }
    double n = 0;
    if (!num(n)) return false;
    out = Value::number(n);
    return true;
  }
};

void write(std::string& out, const Value& v) {
  switch (v.type()) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += v.asBool() ? "true" : "false"; break;
    case Type::Number: appendNumber(out, v.asNumber(0)); break;
    case Type::String: appendQuoted(out, v.asString()); break;
    case Type::Array: {
      out += '[';
      for (size_t k = 0; k < v.size(); k++) {
        if (k) out += ',';
        write(out, v.at(k));
      }
      out += ']';
      break;
    }
    case Type::Object: {
      out += '{';
      const auto& keys = v.keys();
      for (size_t k = 0; k < keys.size(); k++) {
        if (k) out += ',';
        appendQuoted(out, keys[k]);
        out += ':';
        write(out, v.items()[k]);
      }
      out += '}';
      break;
    }
  }
}

}  // namespace

bool parse(std::string_view text, Value& out, std::string* err) {
  Parser p;
  p.s = text;
  Value v;
  if (!p.value(v, 0)) {
    if (err) *err = p.err;
    out = Value();
    return false;
  }
  p.ws();
  if (p.i != text.size()) {
    if (err) *err = "trailing characters at offset " + std::to_string(p.i);
    out = Value();
    return false;
  }
  out = std::move(v);
  return true;
}

std::string stringify(const Value& v) {
  std::string out;
  write(out, v);
  return out;
}

void appendQuoted(std::string& out, std::string_view s) {
  static const char* hex = "0123456789abcdef";
  out += '"';
  for (const char ch : s) {
    const unsigned char c = static_cast<unsigned char>(ch);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out += hex[c >> 4];
          out += hex[c & 15];
        } else {
          out += ch;  // UTF-8 passes through
        }
    }
  }
  out += '"';
}

void appendNumber(std::string& out, double v) {
  if (!std::isfinite(v)) {
    out += "null";
    return;
  }
  char buf[32];
  const auto r = std::to_chars(buf, buf + sizeof(buf), v);  // shortest round-trip form
  out.append(buf, r.ptr);
}

}  // namespace json
}  // namespace om
