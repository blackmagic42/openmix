// Minimal JSON DOM of the engine protocol (owner: host). The Value accessors
// are complete; SKELETON: parse() and stringify() are TODO. SPEC.md §15.1.
#include "om/json.h"

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
  if (type_ != Type::Object) {
    *this = object();
  }
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
  if (type_ != Type::Array) {
    *this = array();
  }
  items_.push_back(std::move(v));
  return *this;
}

bool parse(std::string_view, Value& out, std::string* err) {
  out = Value();
  if (err) *err = "JSON parser not implemented yet";  // TODO(host)
  return false;
}

std::string stringify(const Value&) { return "null"; }  // TODO(host)

void appendQuoted(std::string& out, std::string_view s) {  // TODO(host): escapes
  out += '"';
  out.append(s.data(), s.size());
  out += '"';
}

void appendNumber(std::string& out, double v) { out += std::to_string(v); }  // TODO(host): round-trip format

}  // namespace json
}  // namespace om
