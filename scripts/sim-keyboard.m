// Switch an iOS simulator's HARDWARE keyboard off (or on), so the software
// keyboard rises when a field takes focus.
//
//   xcrun clang -fobjc-arc -framework Foundation -o /tmp/sim-keyboard scripts/sim-keyboard.m
//   /tmp/sim-keyboard <UDID> 0      # off: the on-screen keyboard appears
//   /tmp/sim-keyboard <UDID> 1      # on again
//
// WHY THIS EXISTS. On a simulator booted headless (no Simulator.app, which is
// the only way on a Mac reached over ssh), iOS behaves as if a hardware
// keyboard is attached: a field takes focus, the caret blinks, and no keyboard
// rises — so "the keyboard covers the field" cannot be checked at all, and text
// typed through idb arrives as hardware keys. Simulator.app's own switch
// (I/O > Keyboard > Connect Hardware Keyboard) needs a GUI session. CoreSimulator
// exposes the same switch on SimDevice; this calls it. docs/IOS-BUILD.md.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: sim-keyboard <UDID> 0|1\n");
      return 2;
    }
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
      fprintf(stderr, "could not load CoreSimulator: %s\n", dlerror());
      return 1;
    }
    NSError *err = nil;
    NSString *developerDir = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"]
        ?: @"/Applications/Xcode.app/Contents/Developer";
    id context = ((id(*)(id, SEL, NSString *, NSError **))objc_msgSend)(
        NSClassFromString(@"SimServiceContext"),
        NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), developerDir, &err);
    if (!context) {
      fprintf(stderr, "no simulator service context: %s\n", err.description.UTF8String);
      return 1;
    }
    id deviceSet = ((id(*)(id, SEL, NSError **))objc_msgSend)(
        context, NSSelectorFromString(@"defaultDeviceSetWithError:"), &err);
    NSDictionary *byUDID = ((id(*)(id, SEL))objc_msgSend)(deviceSet, NSSelectorFromString(@"devicesByUDID"));
    NSUUID *udid = [[NSUUID alloc] initWithUUIDString:@(argv[1])];
    id device = udid ? byUDID[udid] : nil;
    if (!device) {
      fprintf(stderr, "no simulator with UDID %s (xcrun simctl list devices)\n", argv[1]);
      return 1;
    }
    BOOL enabled = strcmp(argv[2], "0") != 0;
    BOOL ok = ((BOOL(*)(id, SEL, BOOL, unsigned int, NSError **))objc_msgSend)(
        device, NSSelectorFromString(@"setHardwareKeyboardEnabled:keyboardType:error:"), enabled, 0, &err);
    if (!ok) {
      fprintf(stderr, "could not switch the hardware keyboard: %s\n", err.description.UTF8String);
      return 1;
    }
    printf("hardware keyboard %s\n", enabled ? "on" : "off");
    return 0;
  }
}
