/**
 * Utility for running precise cyclic operations with busy-wait timing.
 * Provides sub-millisecond precision for EtherCAT cycle loops.
 */

export interface CycleLoopOptions {
  /** Cycle time in microseconds */
  cycleTimeUs: number;
  /** Function to execute each cycle. Should return a Promise. */
  cycleFn: () => Promise<number | void>;
  /** Optional callback called after each cycle with execution stats */
  onCycle?: (stats: CycleStats) => void;
  /** Optional callback for errors */
  onError?: (error: Error) => void;
}

export interface CycleStats {
  /** Cycle count since start */
  cycleCount: number;
  /** Average cycle execution time in milliseconds */
  avgExecutionTimeMs: number;
  /** Average interval time (time between cycle starts) in milliseconds */
  avgIntervalTimeMs: number;
  /** Last cycle execution time in milliseconds */
  lastExecutionTimeMs: number;
  /** Last interval time in milliseconds */
  lastIntervalTimeMs: number;
  /** Working counter from last cycle (if cycleFn returns a number) */
  wkc?: number;
}

export interface CycleLoopController {
  /** Start the cycle loop */
  start: () => void;
  /** Stop the cycle loop gracefully */
  stop: () => void;
  /** Check if the loop is currently running */
  isRunning: () => boolean;
  /** Get current cycle statistics */
  getStats: () => CycleStats;
}

/**
 * Creates a precise cycle loop with busy-wait timing.
 *
 * @param options Configuration options for the cycle loop
 * @returns Controller object to start/stop the loop and get statistics
 *
 * @example
 * ```typescript
 * const controller = createCycleLoop({
 *   cycleTimeUs: 1000, // 1ms cycle time
 *   cycleFn: async () => await master.runCycle(),
 *   onCycle: (stats) => {
 *     console.log(`Cycle ${stats.cycleCount}, WKC: ${stats.wkc}`);
 *   }
 * });
 *
 * controller.start();
 * // ... later
 * controller.stop();
 * ```
 */
export function createCycleLoop(
  options: CycleLoopOptions,
): CycleLoopController {
  const { cycleTimeUs, cycleFn, onCycle, onError } = options;
  const cycleTimeMs = cycleTimeUs / 1000;

  let running = false;
  let cycleCount = 0;
  let totalExecutionTime = 0;
  let totalIntervalTime = 0;
  let lastExecutionTimeMs = 0;
  let lastIntervalTimeMs = 0;
  let previousCycleStart: number | null = null;
  let lastWkc: number | undefined;

  const runCycleLoop = async () => {
    let nextCycleTime = performance.now() + cycleTimeMs;

    while (running) {
      try {
        const cycleStart = performance.now();

        // Calculate actual interval time (time between cycle starts)
        if (previousCycleStart !== null) {
          const actualIntervalTime = cycleStart - previousCycleStart;
          totalIntervalTime += actualIntervalTime;
          lastIntervalTimeMs = actualIntervalTime;
        }
        previousCycleStart = cycleStart;

        // Execute the cycle function
        const result = await cycleFn();
        const cycleEnd = performance.now();
        const executionTimeMs = cycleEnd - cycleStart;

        // Update statistics
        cycleCount++;
        totalExecutionTime += executionTimeMs;
        lastExecutionTimeMs = executionTimeMs;

        // Store WKC if cycleFn returned a number
        if (typeof result === "number") {
          lastWkc = result;
        }

        // Call optional cycle callback
        if (onCycle) {
          const avgExecutionTime = totalExecutionTime / cycleCount;
          const avgIntervalTime = cycleCount > 1 ? totalIntervalTime / (cycleCount - 1) : 0;

          onCycle({
            cycleCount,
            avgExecutionTimeMs: avgExecutionTime,
            avgIntervalTimeMs: avgIntervalTime,
            lastExecutionTimeMs,
            lastIntervalTimeMs,
            wkc: lastWkc,
          });
        }

        // Wait until next cycle time
        nextCycleTime = await waitUntilNextCycle(nextCycleTime, cycleTimeMs);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (onError) {
          onError(err);
        } else {
          console.error("Cycle error:", err);
        }
        running = false;
      }
    }
  };

  return {
    start: () => {
      if (running) {
        console.warn("Cycle loop is already running");
        return;
      }
      running = true;
      runCycleLoop();
    },
    stop: () => {
      running = false;
    },
    isRunning: () => running,
    getStats: (): CycleStats => {
      const avgExecutionTime = cycleCount > 0 ? totalExecutionTime / cycleCount : 0;
      const avgIntervalTime = cycleCount > 1 ? totalIntervalTime / (cycleCount - 1) : 0;

      return {
        cycleCount,
        avgExecutionTimeMs: avgExecutionTime,
        avgIntervalTimeMs: avgIntervalTime,
        lastExecutionTimeMs,
        lastIntervalTimeMs,
        wkc: lastWkc,
      };
    },
  };
}

/**
 * Waits until the next cycle time using precise timing.
 * For short waits (<1ms), uses busy-wait for precision.
 * For longer waits, uses setTimeout with busy-wait fine-tuning.
 *
 * @param nextCycleTime Target time for next cycle (performance.now() timestamp)
 * @param cycleTimeMs Cycle time in milliseconds
 * @returns Updated next cycle time
 */
async function waitUntilNextCycle(
  nextCycleTime: number,
  cycleTimeMs: number,
): Promise<number> {
  nextCycleTime += cycleTimeMs;
  const now = performance.now();
  const waitTime = nextCycleTime - now;

  if (waitTime > 0) {
    // For short waits, use busy-wait for precision
    // For longer waits, yield to event loop
    if (waitTime < 1) {
      // Busy-wait for sub-millisecond precision
      while (performance.now() < nextCycleTime) {
        // Busy wait
      }
    } else {
      // For longer waits, use setTimeout but adjust for precision
      await new Promise<void>((resolve) => {
        const start = performance.now();
        setTimeout(() => {
          // Fine-tune with busy-wait for the remaining time
          const elapsed = performance.now() - start;
          const remaining = waitTime - elapsed;
          if (remaining > 0) {
            const target = performance.now() + remaining;
            while (performance.now() < target) {
              // Busy wait
            }
          }
          resolve();
        }, Math.max(0, waitTime - 0.5)); // Leave 0.5ms for busy-wait
      });
    }
  } else {
    // We're behind schedule, adjust next cycle time
    nextCycleTime = performance.now() + cycleTimeMs;
  }

  return nextCycleTime;
}
