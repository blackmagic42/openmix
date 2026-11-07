# Protocol validator of the JS proxy's tests (owner: jsproxy, native/engine/SPEC.md §15):
# the engine's CURRENT parser (src/core/protocol.cpp + src/json/json.cpp) applied
# to every message the proxy posts on the ctl port. Three translation units,
# no engine build needed:
#   cmake -S test/native-engine/protocheck -B <your build dir> -G "Visual Studio 17 2022" -A x64
#   cmake --build <your build dir> --config Release -- /m:1
#   set OM_PROTO_CHECK=<your build dir>\Release\om_proto_check.exe & node --test test/native-engine/
cmake_minimum_required(VERSION 3.25)
project(om_proto_check CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(E "${CMAKE_CURRENT_SOURCE_DIR}/../../../native/engine" ABSOLUTE)
add_executable(om_proto_check main.cpp "${E}/src/core/protocol.cpp" "${E}/src/json/json.cpp")
target_include_directories(om_proto_check PRIVATE "${E}/include")
set_property(TARGET om_proto_check PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
if(MSVC)
  target_compile_options(om_proto_check PRIVATE /utf-8 /permissive- /W3)
endif()
