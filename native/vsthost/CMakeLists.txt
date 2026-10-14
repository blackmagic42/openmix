# OpenMix VST3 host — Node-API module built with cmake-js.
#   npm run build:vst   (fetches the VST3 SDK if needed, then builds)
# Output: native/vsthost/build/Release/openmix_vsthost.node
cmake_minimum_required(VERSION 3.25)
project(openmix_vsthost CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

set(VST3_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../vst3sdk" CACHE PATH "VST3 SDK")

# Only the hosting part of the SDK: no example plugins, no VSTGUI, no validator
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_USE_STATIC_CRT OFF CACHE BOOL "" FORCE)
add_subdirectory(${VST3_SDK_ROOT} ${CMAKE_BINARY_DIR}/vst3sdk EXCLUDE_FROM_ALL)

execute_process(COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../..
  OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

# (the SDK's sdk_hosting library leaves the platform module loader, the plug
# provider and the memory stream to each host — as its own hosting samples do)
add_library(${PROJECT_NAME} SHARED
  src/vsthost.cpp
  ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp
  ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp
  ${VST3_SDK_ROOT}/public.sdk/source/common/memorystream.cpp
  ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} ${VST3_SDK_ROOT})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS UNICODE _UNICODE)
target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB} sdk_hosting avrt ole32)
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
