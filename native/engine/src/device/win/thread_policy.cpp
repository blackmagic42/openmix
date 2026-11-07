// Real-time thread policy on Windows (owner: device, library
// om_device_wasapi): MMCSS task at AVRT_PRIORITY_HIGH and thread power
// throttling off for the audio, phones, NULL pacer and VST deck worker
// threads; process power throttling (EcoQoS) off and timer-resolution
// requests kept honoured while throttled, re-applied by the control thread
// every 10 s; and the read-back of both (GetProcessInformation,
// GetThreadInformation, AvQuerySystemResponsiveness) for the tests and the
// state. A minimized window with a game running must not slow the engine
// host down. SPEC.md §8.8.
#include <windows.h>
#include <avrt.h>

#include <string>

#include "om/device.h"

namespace om {

void* promoteAudioThread(const char* mmcssTask, std::string* err) {
  // Thread power throttling off (Windows 10 1709+; ignored where unknown).
  THREAD_POWER_THROTTLING_STATE tp{};
  tp.Version = THREAD_POWER_THROTTLING_CURRENT_VERSION;
  tp.ControlMask = THREAD_POWER_THROTTLING_EXECUTION_SPEED;
  tp.StateMask = 0;  // controlled and NOT throttled
  SetThreadInformation(GetCurrentThread(), ThreadPowerThrottling, &tp, sizeof(tp));
  wchar_t task[64] = L"Pro Audio";
  if (mmcssTask && *mmcssTask) {
    const int n = MultiByteToWideChar(CP_UTF8, 0, mmcssTask, -1, task, 64);
    if (n <= 0) wcscpy_s(task, L"Pro Audio");
  }
  DWORD index = 0;
  HANDLE h = AvSetMmThreadCharacteristicsW(task, &index);
  if (!h) {
    // No MMCSS (service disabled by a "latency tweak", unknown task): the
    // thread still runs at TIME_CRITICAL, like Chromium's audio thread and
    // the VST deck workers, never at normal priority next to a game.
    const DWORD code = GetLastError();
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    if (err) *err = "AvSetMmThreadCharacteristics failed (" + std::to_string(code) + "): TIME_CRITICAL priority instead";
    return nullptr;
  }
  AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH);
  return h;
}

void raiseServiceThreadPriority() noexcept { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL); }

void demoteAudioThread(void* handle) {
  if (handle) AvRevertMmThreadCharacteristics(static_cast<HANDLE>(handle));
}

bool disableProcessPowerThrottling(std::string* err) {
  PROCESS_POWER_THROTTLING_STATE pp{};
  pp.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  // Execution speed not throttled; timer resolution requests honoured even
  // when the process is considered in the background (Windows 11).
  pp.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
  pp.StateMask = 0;  // controlled and NOT throttled / NOT ignored
  if (SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &pp, sizeof(pp))) return true;
  // Windows 10 knows only the execution-speed flag.
  pp.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
  if (!SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &pp, sizeof(pp))) {
    if (err) *err = "SetProcessInformation(ProcessPowerThrottling) failed (" + std::to_string(GetLastError()) + ")";
    return false;
  }
  return true;
}

bool queryProcessPowerThrottling(bool* throttlingOff, std::string* err) {
  PROCESS_POWER_THROTTLING_STATE pp{};
  pp.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
  if (!GetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &pp, sizeof(pp))) {
    if (err) *err = "GetProcessInformation(ProcessPowerThrottling) failed (" + std::to_string(GetLastError()) + ")";
    if (throttlingOff) *throttlingOff = false;
    return false;
  }
  if (throttlingOff)
    *throttlingOff = (pp.ControlMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED) &&
                     !(pp.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED);
  return true;
}

bool queryAudioThreadPolicy(void* mmcssHandle, ThreadPolicyInfo& out) {
  out = ThreadPolicyInfo();
  out.supported = true;
  out.priority = GetThreadPriority(GetCurrentThread());
  THREAD_POWER_THROTTLING_STATE tp{};
  tp.Version = THREAD_POWER_THROTTLING_CURRENT_VERSION;
  if (GetThreadInformation(GetCurrentThread(), ThreadPowerThrottling, &tp, sizeof(tp))) {
    out.powerThrottlingKnown = true;
    out.powerThrottlingOff =
        (tp.ControlMask & THREAD_POWER_THROTTLING_EXECUTION_SPEED) && !(tp.StateMask & THREAD_POWER_THROTTLING_EXECUTION_SPEED);
  }
  if (mmcssHandle) {
    ULONG resp = 0;
    if (AvQuerySystemResponsiveness(static_cast<HANDLE>(mmcssHandle), &resp)) {
      out.mmcss = true;
      out.systemResponsiveness = resp;
    }
  }
  return true;
}

}  // namespace om
