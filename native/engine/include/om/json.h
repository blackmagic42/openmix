// Minimal JSON DOM (parse / stringify) for the engine protocol, so that no
// external library is needed (owner: host). Control thread only: it
// allocates. Numbers are doubles; object member order is preserved.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace om {
namespace json {

enum class Type : uint8_t { Null = 0, Bool, Number, String, Array, Object };

class Value {
 public:
  Value() = default;
  static Value null() { return Value(); }
  static Value boolean(bool b);
  static Value number(double n);
  static Value string(std::string s);
  static Value array();
  static Value object();

  Type type() const noexcept { return type_; }
  bool isNull() const noexcept { return type_ == Type::Null; }
  bool isBool() const noexcept { return type_ == Type::Bool; }
  bool isNumber() const noexcept { return type_ == Type::Number; }
  bool isString() const noexcept { return type_ == Type::String; }
  bool isArray() const noexcept { return type_ == Type::Array; }
  bool isObject() const noexcept { return type_ == Type::Object; }

  // Typed reads with a default when the type does not match.
  bool asBool(bool def = false) const noexcept;
  double asNumber(double def) const noexcept;
  const std::string& asString() const noexcept;  // "" when not a string

  // Object access: missing key -> a shared null value.
  const Value& operator[](std::string_view key) const noexcept;
  bool has(std::string_view key) const noexcept;
  Value& set(std::string key, Value v);           // object (converts null to object)
  const std::vector<std::string>& keys() const noexcept { return keys_; }

  // Array access: out of range -> a shared null value.
  const Value& at(size_t i) const noexcept;
  size_t size() const noexcept;                   // array items or object members
  Value& push(Value v);                           // array (converts null to array)
  const std::vector<Value>& items() const noexcept { return items_; }

 private:
  Type type_ = Type::Null;
  bool b_ = false;
  double n_ = 0;
  std::string s_;
  std::vector<std::string> keys_;  // object keys (parallel to items_)
  std::vector<Value> items_;       // array items or object values
};

// Parses a complete JSON text. On error returns false and describes it in *err.
bool parse(std::string_view text, Value& out, std::string* err);
// Compact serialization (numbers with round-trip precision, NaN/Inf as null).
std::string stringify(const Value& v);
void appendQuoted(std::string& out, std::string_view s);
void appendNumber(std::string& out, double v);

}  // namespace json
}  // namespace om
