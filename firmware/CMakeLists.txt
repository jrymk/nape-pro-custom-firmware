cmake_minimum_required(VERSION 3.20)
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(nape_maintenance)
zephyr_include_directories(include)
target_sources(app PRIVATE src/main.c src/service.c src/indicator.c src/indicator_color.c
  src/input_engine.c)
if(NAPE_MAIN)
  target_compile_definitions(app PRIVATE NAPE_MAIN=1)
  target_include_directories(app PRIVATE drivers/vendor)
  target_sources(app PRIVATE src/profile_config.c src/config_store.c src/profile_history.c src/runtime.c src/motion_processor.c
    src/report_transport.c drivers/board_input.c drivers/paw3222.c drivers/vendor/rtl_spi3w.c)
endif()
if(CONFIG_REALTEK_PPT)
  set(RF_VENDOR ${CMAKE_CURRENT_SOURCE_DIR}/radio/vendor/realtek)
  target_sources(app PRIVATE radio/radio_link.c radio/stock_codec.c
    ${RF_VENDOR}/common/ppt_driver.c ${RF_VENDOR}/simple/ppt_simple.c)
  target_include_directories(app PRIVATE radio ${RF_VENDOR}/common
    ${RF_VENDOR}/common/rtl87x2g ${RF_VENDOR}/simple)
  target_compile_definitions(app PRIVATE CONFIG_PPT_DRIVER_LOG_LEVEL=0)
endif()
