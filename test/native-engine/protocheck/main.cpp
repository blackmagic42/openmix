// Protocol validator of the JS proxy's tests (owner: jsproxy, native/engine/SPEC.md §15): reads one
// JSON message per line (a command or a batch, as the proxy posts them on the ctl port) and prints,
// per line, "OK <n commands>" or "ERR <reason>" from the engine's real parser (om::parseCommands).
#include <iostream>
#include <string>
#include <vector>
#include "om/protocol.h"

int main() {
  std::string line;
  int bad = 0, n = 0;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    n++;
    std::vector<om::ParsedCommand> out;
    std::string err;
    if (om::parseCommands(line, out, &err)) {
      std::cout << "OK " << out.size() << "\n";
    } else {
      bad++;
      std::cout << "ERR " << err << "\n";
    }
  }
  std::cerr << n << " messages, " << bad << " refused\n";
  return bad ? 1 : 0;
}
