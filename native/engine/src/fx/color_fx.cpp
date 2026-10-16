// Color FX bus effects of the channel FILTER knobs (owner: fx).
// SKELETON: outputs silence. SPEC.md §10.4.
#include <cstring>

#include "om/color_fx.h"

namespace om {

struct ColorFx::Impl {
  ColorType type = ColorType::Filter;
};

ColorFx::ColorFx() : impl_(std::make_unique<Impl>()) {}
ColorFx::~ColorFx() = default;

void ColorFx::prepare(double, int) {}
void ColorFx::setType(ColorType t) noexcept { impl_->type = t; }
ColorType ColorFx::type() const noexcept { return impl_->type; }
void ColorFx::reset() noexcept {}

void ColorFx::process(const float*, const float*, float* outL, float* outR, int n) noexcept {
  std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
}

}  // namespace om
