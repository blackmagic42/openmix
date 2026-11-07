# libopenmix — the native C++ audio engine of OpenMix (owner: host).
#
# One static library per module, one plain C++ test executable per module
# (om_test_<module>), and the Electron add-on openmix_engine.node.
#
#   npm run build:engine                 -> cmake-js, Electron runtime, x64, Release:
#                                           native/engine/build/Release/openmix_engine.node
#   node tools/build-engine.js --tests   -> every module test (Debug) in native/engine/build-tests + ctest
#   node tools/build-engine.js --module m-> one module's test in native/engine/build-tests-m
#   node tools/build-engine.js --portable / --sanitize address  (SPEC.md §18.5)
#
# Rules (SPEC.md §18): C++20; static C runtime (/MT) everywhere on MSVC, the
# VST3 SDK included; no download (only the Windows SDK, native/vst3sdk,
# node-addon-api and cmake-js from node_modules); module sources are globbed
# per folder so that each owner adds files without touching this file.
# Windows-only code lives in src/<module>/win/ (separate libraries), the
# stand-ins used without a backend in src/<module>/none/: the portable set
# builds everywhere (outside Windows, or with OM_PORTABLE_ONLY=ON).
cmake_minimum_required(VERSION 3.25)
project(libopenmix VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  # Static CRT for every target (cmake-js passes the same value).
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" CACHE STRING "" FORCE)
endif()

if(CMAKE_JS_VERSION)
  set(OM_BUILD_NODE_DEFAULT ON)
  set(OM_BUILD_TESTS_DEFAULT OFF)
else()
  set(OM_BUILD_NODE_DEFAULT OFF)
  set(OM_BUILD_TESTS_DEFAULT ON)
endif()
option(OM_BUILD_NODE "Build openmix_engine.node (cmake-js only)" ${OM_BUILD_NODE_DEFAULT})
option(OM_BUILD_TESTS "Build the module test executables" ${OM_BUILD_TESTS_DEFAULT})
option(OM_WITH_VST "Build the VST3 inline host (Windows, needs native/vst3sdk)" ON)
option(OM_RT_TRAP "Count heap allocations and frees on the audio thread in openmix_engine.node" OFF)
option(OM_PORTABLE_ONLY "Build only the portable set (no src/*/win/ library), even on Windows" OFF)
set(OM_SANITIZE "" CACHE STRING "Sanitizer for the test build: address | thread | undefined | realtime (empty = none)")
set(OM_TEST_MODULES "core;device;decoder;deck;mixer;fx;sync;vst" CACHE STRING "Module test executables to define")
set(OM_VST3_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../vst3sdk" CACHE PATH "Steinberg VST3 SDK (MIT)")

if(WIN32 AND NOT OM_PORTABLE_ONLY)
  set(OM_WIN_BACKENDS ON)
else()
  set(OM_WIN_BACKENDS OFF)
endif()
if(OM_WIN_BACKENDS AND OM_WITH_VST AND NOT OM_SANITIZE)
  set(OM_VST_SDK ON)
else()
  set(OM_VST_SDK OFF)
endif()
message(STATUS "libopenmix: Windows backends ${OM_WIN_BACKENDS}, VST3 SDK ${OM_VST_SDK}, sanitizer '${OM_SANITIZE}', tests '${OM_TEST_MODULES}'")

# ---------------------------------------------------------------------------
# Common options (C++20, warnings, UTF-8 sources, platform defines, sanitizers)
# ---------------------------------------------------------------------------
find_package(Threads REQUIRED)
add_library(om_options INTERFACE)
target_compile_features(om_options INTERFACE cxx_std_20)
target_include_directories(om_options INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(om_options INTERFACE Threads::Threads)
if(WIN32)
  target_compile_definitions(om_options INTERFACE NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE _CRT_SECURE_NO_WARNINGS)
endif()
if(MSVC)
  # /fp:precise keeps the DSP bit-comparable with the reference renders (no fast-math).
  # No /MP: the shared PC builds with a few parallel projects at below-normal priority.
  target_compile_options(om_options INTERFACE /W4 /permissive- /utf-8 /Zc:__cplusplus /EHsc /fp:precise /wd4324)
else()
  # -ffp-contract=off: no FMA contraction, so results stay comparable with the reference renders.
  target_compile_options(om_options INTERFACE -Wall -Wextra -ffp-contract=off -fno-fast-math)
endif()

if(OM_SANITIZE)
  if(MSVC)
    if(NOT OM_SANITIZE STREQUAL "address")
      message(FATAL_ERROR "MSVC supports OM_SANITIZE=address only (thread / undefined / realtime: clang, in CI)")
    endif()
    # ASan is incompatible with the runtime checks and incremental linking of Debug builds.
    foreach(_v CMAKE_CXX_FLAGS_DEBUG CMAKE_C_FLAGS_DEBUG)
      string(REPLACE "/RTC1" "" ${_v} "${${_v}}")
    endforeach()
    target_compile_options(om_options INTERFACE /fsanitize=address /Zi)
    target_link_options(om_options INTERFACE /INCREMENTAL:NO /DEBUG)
  else()
    target_compile_options(om_options INTERFACE -fsanitize=${OM_SANITIZE} -fno-omit-frame-pointer -g)
    target_link_options(om_options INTERFACE -fsanitize=${OM_SANITIZE})
  endif()
endif()

# A static library from every .cpp of one folder (owners add files freely).
function(om_library name dir)
  file(GLOB _src CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${dir}/*.cpp")
  if(NOT _src)
    message(FATAL_ERROR "${name}: no source in ${dir}")
  endif()
  add_library(${name} STATIC ${_src})
  target_link_libraries(${name} PUBLIC om_options)
  set_target_properties(${name} PROPERTIES FOLDER "modules")
endfunction()

# ---------------------------------------------------------------------------
# Module libraries
# ---------------------------------------------------------------------------
om_library(om_json src/json)

# Device: portable part + WASAPI backend (or stand-ins)
om_library(om_device src/device)
# om_device calls the platform seam implemented by its backend (pacer timer,
# files) while the backend links om_device: a static-library cycle. MSVC and
# lld resolve it; declare the multiplicity so single-pass linkers work too.
set_target_properties(om_device PROPERTIES LINK_INTERFACE_MULTIPLICITY 2)
if(OM_WIN_BACKENDS)
  om_library(om_device_wasapi src/device/win)
  target_link_libraries(om_device_wasapi PUBLIC om_device PRIVATE ole32 avrt uuid ksuser)
  set(OM_DEVICE_BACKEND om_device_wasapi)
else()
  om_library(om_device_none src/device/none)
  target_link_libraries(om_device_none PUBLIC om_device)
  set(OM_DEVICE_BACKEND om_device_none)
endif()

# Decoder: portable PCM store / conversions / shadow pipeline + Media Foundation reader (or stand-ins)
om_library(om_pcm src/decoder)
if(OM_WIN_BACKENDS)
  om_library(om_shadow_mf src/decoder/win)
  target_link_libraries(om_shadow_mf PUBLIC om_pcm PRIVATE mfplat mfreadwrite mfuuid ole32 propsys)
  set(OM_SHADOW_BACKEND om_shadow_mf)
else()
  om_library(om_shadow_none src/decoder/none)
  target_link_libraries(om_shadow_none PUBLIC om_pcm)
  set(OM_SHADOW_BACKEND om_shadow_none)
endif()
# The recorder's writer thread resamples a device at another rate to the
# recording's rate (om::Resampler, portable): one set = one file (SPEC.md §14).
target_link_libraries(om_device PUBLIC om_pcm)

om_library(om_deck src/deck)
om_library(om_fx src/fx)
om_library(om_mixer src/mixer)   # FX seam: the mixer does NOT link om_fx (SPEC.md §10.3)
om_library(om_sync src/sync)

# VST3 inline host: portable shell (worker handoff, dry lines, status) + the
# SDK / Win32 part (or stand-ins)
if(OM_VST_SDK)
  if(NOT EXISTS "${OM_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module.h")
    message(FATAL_ERROR "VST3 SDK not found in ${OM_VST3_SDK_ROOT} (or configure with -DOM_WITH_VST=OFF)")
  endif()
  file(GLOB _vst_src CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/vst/*.cpp" "${CMAKE_CURRENT_SOURCE_DIR}/src/vst/win/*.cpp")
  add_library(om_vst STATIC ${_vst_src})
  target_link_libraries(om_vst PUBLIC om_options)
  set_target_properties(om_vst PROPERTIES FOLDER "modules")
  set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
  set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
  set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
  set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
  add_subdirectory("${OM_VST3_SDK_ROOT}" "${CMAKE_BINARY_DIR}/vst3sdk" EXCLUDE_FROM_ALL)
  # sdk_hosting leaves the platform module loader, the plug provider and the
  # memory stream to each host (as native/vsthost does): they are compiled in
  # a small glue library with the SDK's own warning level and C++17.
  add_library(om_vst3_glue STATIC
    "${OM_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp"
    "${OM_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
    "${OM_VST3_SDK_ROOT}/public.sdk/source/common/memorystream.cpp")
  set_target_properties(om_vst3_glue PROPERTIES CXX_STANDARD 17 FOLDER "vst3sdk")
  target_compile_definitions(om_vst3_glue PRIVATE NOMINMAX UNICODE _UNICODE)
  target_include_directories(om_vst3_glue PUBLIC "${OM_VST3_SDK_ROOT}")
  target_link_libraries(om_vst3_glue PUBLIC sdk_hosting ole32)
  target_compile_definitions(om_vst PUBLIC OM_WITH_VST=1)
  target_link_libraries(om_vst PRIVATE om_vst3_glue avrt)
  foreach(_t base pluginterfaces sdk_common sdk_hosting)
    if(TARGET ${_t})
      set_target_properties(${_t} PROPERTIES MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" FOLDER "vst3sdk")
    endif()
  endforeach()
else()
  file(GLOB _vst_src CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/vst/*.cpp" "${CMAKE_CURRENT_SOURCE_DIR}/src/vst/none/*.cpp")
  add_library(om_vst STATIC ${_vst_src})
  target_link_libraries(om_vst PUBLIC om_options)
  set_target_properties(om_vst PROPERTIES FOLDER "modules")
endif()

# The core: command routing, render callback, control / ops / vst-ops threads, flat C API
om_library(om_core src/core)
target_link_libraries(om_core PUBLIC om_json ${OM_DEVICE_BACKEND} ${OM_SHADOW_BACKEND} om_deck om_mixer om_fx om_sync om_vst)

# ---------------------------------------------------------------------------
# openmix_engine.node (cmake-js: Electron runtime)
# ---------------------------------------------------------------------------
if(OM_BUILD_NODE)
  set(_node_src "${CMAKE_CURRENT_SOURCE_DIR}/src/node/binding.cpp" ${CMAKE_JS_SRC})
  if(OM_RT_TRAP)
    list(APPEND _node_src "${CMAKE_CURRENT_SOURCE_DIR}/src/node/rt_trap.cpp")
  endif()
  add_library(openmix_engine SHARED ${_node_src})
  set_target_properties(openmix_engine PROPERTIES PREFIX "" SUFFIX ".node")
  if(NOT NODE_ADDON_API_DIR)
    execute_process(COMMAND node -p "require('node-addon-api').include"
      WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
      OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
    string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
  endif()
  target_include_directories(openmix_engine PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
  target_compile_definitions(openmix_engine PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS)
  if(MSVC)
    target_compile_options(openmix_engine PRIVATE /wd4127)  # node-addon-api headers
  endif()
  target_link_libraries(openmix_engine PRIVATE om_core ${CMAKE_JS_LIB})
  if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
  endif()
endif()

# ---------------------------------------------------------------------------
# Module tests: plain C++ executables, silent (NULL device / offline buffers).
# Each links only its own module (the mixer's tests use fake FX processors).
# ---------------------------------------------------------------------------
if(OM_BUILD_TESTS)
  enable_testing()
  function(om_test name)
    if(NOT name IN_LIST OM_TEST_MODULES)
      return()
    endif()
    file(GLOB _tests CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tests/${name}/*.cpp")
    add_executable(om_test_${name} "${CMAKE_CURRENT_SOURCE_DIR}/tests/om_test_main.cpp" ${_tests})
    target_link_libraries(om_test_${name} PRIVATE om_json ${ARGN})
    target_include_directories(om_test_${name} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/tests")
    set_target_properties(om_test_${name} PROPERTIES FOLDER "tests")
    add_test(NAME ${name} COMMAND om_test_${name})
    set_tests_properties(${name} PROPERTIES TIMEOUT 300)
    if(MSVC AND OM_SANITIZE STREQUAL "address")
      # MSVC's ASan runtime is a DLL (for /MT too): put it next to the test,
      # or the loader stops on a "DLL not found" dialog.
      get_filename_component(_cl_dir "${CMAKE_CXX_COMPILER}" DIRECTORY)
      foreach(_dll clang_rt.asan_dynamic-x86_64.dll clang_rt.asan_dbg_dynamic-x86_64.dll)
        if(EXISTS "${_cl_dir}/${_dll}")
          add_custom_command(TARGET om_test_${name} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_cl_dir}/${_dll}" "$<TARGET_FILE_DIR:om_test_${name}>")
        endif()
      endforeach()
    endif()
  endfunction()
  om_test(core om_core)
  om_test(device ${OM_DEVICE_BACKEND})
  om_test(decoder ${OM_SHADOW_BACKEND})
  om_test(deck om_deck)
  om_test(mixer om_mixer)
  om_test(fx om_fx)
  om_test(sync om_sync)
  om_test(vst om_vst)
endif()
