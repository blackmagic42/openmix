// Stand-ins of the system decoder where none is built (owner: decoder,
// library om_shadow_none): portable builds (OM_PORTABLE_ONLY, macOS / Linux
// CI). The shadow comparison still works on WAV files (openWavReader).
// SPEC.md §7.4, §18.5.
#include "om/shadow.h"

namespace om {

std::unique_ptr<IAudioFileReader> openSystemReader(const std::string&, DecodeError* err, std::string* message) {
  if (err) *err = DecodeError::Unsupported;
  if (message) *message = "no system decoder in this build";
  return nullptr;
}

bool mediaFoundationAvailable(std::string* err) {
  if (err) *err = "Media Foundation is Windows-only";
  return false;
}

}  // namespace om
