# "OM Spy" VST3 test plugin for tests/vst (owner: decoder). Not part of the
# engine build (the engine's test glob only takes tests/vst/*.cpp): built on
# its own into the decoder owner's folder, then passed to om_test_vst with
# OM_TEST_VST_SPY=<path to om-spy.vst3>:
#   cmake -S native/engine/tests/vst/spy -B native/engine/build-tests-vst-spy -G "Visual Studio 17 2022" -A x64
#   cmake --build native/engine/build-tests-vst-spy --config Release
# Only the VST3 SDK interfaces from native/vst3sdk (MIT), static CRT.
cmake_minimum_required(VERSION 3.25)
project(om_spy_plugin CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(SDK "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vst3sdk")
add_library(om_spy SHARED
  "${CMAKE_CURRENT_SOURCE_DIR}/om_spy_plugin.cxx"
  "${SDK}/pluginterfaces/base/funknown.cpp"
  "${SDK}/pluginterfaces/base/coreiids.cpp"
  "${SDK}/public.sdk/source/vst/vstinitiids.cpp")
set_source_files_properties("${CMAKE_CURRENT_SOURCE_DIR}/om_spy_plugin.cxx" PROPERTIES LANGUAGE CXX)
target_include_directories(om_spy PRIVATE "${SDK}")
target_compile_definitions(om_spy PRIVATE NOMINMAX UNICODE _UNICODE _CRT_SECURE_NO_WARNINGS)
set_target_properties(om_spy PROPERTIES OUTPUT_NAME "om-spy" SUFFIX ".vst3")
