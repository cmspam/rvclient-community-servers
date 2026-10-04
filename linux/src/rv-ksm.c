/*
 * rv-ksm: run a program with all of its memory marked as mergeable for KSM (Kernel Samepage
 * Merging), so identical pages of several game servers are kept only once.
 *
 *   rv-ksm <program> [args...]
 *
 * PR_SET_MEMORY_MERGE (Linux 6.4+) applies to this process and is kept across exec, so the
 * program started here (Wine, then the game) inherits it. It needs CAP_SYS_RESOURCE. When the
 * call fails, the program is started anyway, without KSM.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

#ifndef PR_SET_MEMORY_MERGE
#define PR_SET_MEMORY_MERGE 67
#endif

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: rv-ksm <program> [args...]\n");
        return 2;
    }
    if (prctl(PR_SET_MEMORY_MERGE, 1, 0, 0, 0) != 0)
        fprintf(stderr, "rv-ksm: KSM not enabled for %s: %s\n", argv[1], strerror(errno));
    execvp(argv[1], argv + 1);
    fprintf(stderr, "rv-ksm: cannot start %s: %s\n", argv[1], strerror(errno));
    return 127;
}
