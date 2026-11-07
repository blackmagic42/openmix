/* Flat C interface of libopenmix, the OpenMix native audio engine (owner:
 * host). The ONLY boundary between the engine and its hosts: the Node-API
 * binding (openmix_engine.node) is a thin layer over these functions, and a
 * later out-of-process engine or another shell reuses them unchanged.
 *
 *   create/destroy, start/stop    lifecycle (NULL device or WASAPI)
 *   om_engine_set_policy()         trusted paths from main (VST folders...)
 *   om_engine_command()            one JSON command or batch (SPEC.md §15)
 *   om_engine_set_event_callback() JSON events (state, hb, replies...)
 *   om_engine_read_state()         latest state snapshot as a C struct
 *   om_pcm_*()                     PCM handoff data path (SPEC.md §7)
 *   om_engine_pump/render()        manual mode: deterministic offline tests
 *   om_list_output_devices(),
 *   om_vst_scan(), om_shadow_run() helpers usable without an engine (the
 *                                  last two only in their helper processes)
 *
 * Threading: every function may be called from any non-real-time thread and
 * never blocks on a device, a file or a plugin (slow commands are queued
 * inside the engine, SPEC.md §3.3). The event callback runs on an engine
 * thread (control, ops, vst-ops) or inside om_engine_command() /
 * om_engine_pump() in manual mode, one call at a time, and must not call
 * om_engine_destroy(). Strings are UTF-8.
 */
#ifndef OM_ENGINE_H
#define OM_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#include "om/om_state.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef OM_API
#define OM_API
#endif

#define OM_PROTOCOL_VERSION 2

typedef struct om_engine om_engine;

typedef enum om_result {
  OM_OK = 0,
  OM_ERR_INVALID = -1,     /* bad arguments or malformed JSON */
  OM_ERR_STATE = -2,       /* wrong lifecycle state (not started, stream incomplete or aborted...) */
  OM_ERR_NOMEM = -3,
  OM_ERR_DEVICE = -4,
  OM_ERR_UNSUPPORTED = -5,
  OM_ERR_FULL = -6,        /* the command queue cannot take the whole message now: nothing applied, retry */
  OM_ERR_NOT_FOUND = -7,
  OM_ERR_RANGE = -8,
  OM_ERR_INTERNAL = -9
} om_result;

/* One event: a JSON object text of `len` bytes (not NUL-terminated). */
typedef void (*om_event_fn)(void* user, const char* json, size_t len);

typedef struct om_config {
  uint32_t struct_size;        /* sizeof(om_config) (set by om_config_init) */
  int32_t null_device;         /* 1 = NULL device: never touches a sound card */
  int32_t null_sample_rate;    /* NULL device: 48000 */
  int32_t null_block_frames;   /* NULL device: 256 */
  int32_t null_channels;       /* NULL device: 4 (cue on 3/4 testable) */
  int32_t null_latency_frames; /* NULL device: presentTime - callbackTime, 256 */
  int32_t null_realtime;       /* NULL device paced by a thread (soak tests) */
  int32_t manual;              /* 1 = no threads: om_engine_pump()/om_engine_render() drive everything */
  int32_t state_hz;            /* maximum state event rate (60) */
  int32_t heartbeat_ms;        /* "hb" event period (250) */
  int32_t stall_ms;            /* audio stall threshold (500) */
  uint64_t max_pcm_bytes;      /* PCM memory limit (0 = none) */
  const char* data_dir;        /* writable folder for recordings (UTF-8), may be NULL */
  /* --- appended in protocol 2 (struct_size tells which fields a caller knows) --- */
  uint64_t owner_window;       /* main window handle (HWND) owning the plugin editors, 0 = none (from main only) */
  int32_t stalled_ms;          /* no audio this long after a stall restart = device {reason:"stalled"} (2000) */
  int32_t loss_retry_ms;       /* while the configured device is lost: re-check period (2000) */
} om_config;

OM_API void om_config_init(om_config* cfg);
OM_API const char* om_version(void);
OM_API int32_t om_protocol_version(void);

/* Lifecycle. err (may be NULL) receives a message on failure. */
OM_API om_engine* om_engine_create(const om_config* cfg, char* err, size_t err_len);
OM_API void om_engine_destroy(om_engine* e);
OM_API om_result om_engine_start(om_engine* e, char* err, size_t err_len);
OM_API void om_engine_stop(om_engine* e);
OM_API void om_engine_set_event_callback(om_engine* e, om_event_fn fn, void* user);

/* TRUSTED configuration from main (never from the renderer's ctl port):
 * {"vstRoots":["C:\\...\\VST3"], "vstFiles":["...\\x.vst3"]} (SPEC.md §15.6). */
OM_API om_result om_engine_set_policy(om_engine* e, const char* json, size_t len, char* err, size_t err_len);

/* Commands: one JSON object or an array of objects (applied in order).
 * Invalid input is rejected as a whole (OM_ERR_INVALID, message in err); a
 * message the command queue cannot take whole is rejected (OM_ERR_FULL). */
OM_API om_result om_engine_command(om_engine* e, const char* json, size_t len, char* err, size_t err_len);

/* State and clock. */
OM_API om_result om_engine_read_state(om_engine* e, om_state* out);
OM_API double om_engine_now(const om_engine* e);

/* PCM handoff (SPEC.md §7). The descriptor mirrors the JSON "pcm.begin". */
typedef enum om_pcm_format { OM_PCM_S16 = 1, OM_PCM_F32 = 2 } om_pcm_format;
typedef enum om_pcm_kind { OM_PCM_TRACK = 0, OM_PCM_STEM = 1, OM_PCM_SAMPLE = 2 } om_pcm_kind;
#define OM_PCM_CHUNK_FRAMES 65536
#define OM_PCM_MAX_CHANNELS 8
typedef struct om_pcm_desc {
  uint32_t struct_size;     /* sizeof(om_pcm_desc) */
  uint32_t load_id;         /* > 0, unique per connection */
  int32_t kind;             /* om_pcm_kind */
  int32_t format;           /* om_pcm_format: how the engine STORES it (the wire is float32) */
  int32_t source_channels;  /* channels of the decoded source, 1..8 (folded to stereo by the engine) */
  int32_t sample_rate;      /* rate of the decoded PCM */
  int64_t frames;
  float headroom;           /* S16: the track's max(1, peak), or 0 = per-chunk headroom */
  float peak;               /* source peak (diagnostics) */
} om_pcm_desc;
OM_API om_result om_pcm_begin(om_engine* e, const om_pcm_desc* d);
/* One chunk of float32 PLANAR samples: channel c at planar + c * frames.
 * offset_frames is a multiple of OM_PCM_CHUNK_FRAMES, frames the exact
 * length of that chunk (the last one may be shorter), 1 <= channels <= 8. */
OM_API om_result om_pcm_write(om_engine* e, uint32_t load_id, int64_t offset_frames, int32_t frames,
                              int32_t channels, const float* planar);
OM_API om_result om_pcm_end(om_engine* e, uint32_t load_id);
OM_API void om_pcm_abort(om_engine* e, uint32_t load_id);

/* Manual mode (om_config.manual = 1). */
OM_API om_result om_engine_pump(om_engine* e);
/* Renders `frames` frames of the NULL device into `out` (interleaved,
 * channels of the current NULL device — om_config.null_channels until a
 * device change; may be NULL). `frames` must be a multiple of the NULL
 * device's block (om_config.null_block_frames until a device change).
 * Returns frames rendered (0 on error, or while another device is the
 * output). Events produced meanwhile are delivered by om_engine_pump(). */
OM_API int32_t om_engine_render(om_engine* e, float* out, int32_t frames);

/* Helpers usable without an engine. Results are delivered as one JSON text
 * to `fn` before the function returns. */
OM_API om_result om_list_output_devices(om_event_fn fn, void* user);
/* Scans VST3 files (JSON array of paths). Only in the separate scan process
 * (engine-host.js --scan): loading plugin DLLs may crash. */
OM_API om_result om_vst_scan(const char* paths_json, size_t len, om_event_fn fn, void* user);
/* Shadow decode of one file compared with the reference window cut by the
 * renderer (SPEC.md §7.4). Only in the separate shadow process
 * (engine-host.js --shadow): Media Foundation loads third-party codecs.
 * job_json: {"loadId","path","rate","frames","windowStart"}; left/right:
 * `frames` float32 samples of the window. Delivers the report JSON. */
OM_API om_result om_shadow_run(const char* job_json, size_t len, const float* left, const float* right,
                               int64_t frames, om_event_fn fn, void* user);

#ifdef __cplusplus
}
#endif

#endif /* OM_ENGINE_H */
