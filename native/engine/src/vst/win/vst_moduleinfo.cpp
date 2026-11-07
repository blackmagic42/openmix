// The VST3 SDK's moduleinfo.json parser compiled into om_vst (owner:
// decoder): the engine's SDK glue library leaves it out, and the scan reads
// a bundle's Contents/Resources/moduleinfo.json before (instead of) loading
// its DLL. SDK code: its own warning level. SPEC.md §13.6.
#pragma warning(push, 0)
#include "public.sdk/source/vst/moduleinfo/moduleinfoparser.cpp"
#pragma warning(pop)
