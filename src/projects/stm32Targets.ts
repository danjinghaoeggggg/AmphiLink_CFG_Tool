const FAMILY_TARGETS: Array<[RegExp, string]> = [
  [/^STM32C0/i, 'target/stm32c0x.cfg'],
  [/^STM32F0/i, 'target/stm32f0x.cfg'],
  [/^STM32F1/i, 'target/stm32f1x.cfg'],
  [/^STM32F2/i, 'target/stm32f2x.cfg'],
  [/^STM32F3/i, 'target/stm32f3x.cfg'],
  [/^STM32F4/i, 'target/stm32f4x.cfg'],
  [/^STM32F7/i, 'target/stm32f7x.cfg'],
  [/^STM32G0/i, 'target/stm32g0x.cfg'],
  [/^STM32G4/i, 'target/stm32g4x.cfg'],
  [/^STM32H7R|^STM32H7S/i, 'target/stm32h7rsx.cfg'],
  [/^STM32H7/i, 'target/stm32h7x.cfg'],
  [/^STM32L0/i, 'target/stm32l0.cfg'],
  [/^STM32L1/i, 'target/stm32l1.cfg'],
  [/^STM32L4/i, 'target/stm32l4x.cfg'],
  [/^STM32L5/i, 'target/stm32l5x.cfg'],
  [/^STM32N6/i, 'target/stm32n6x.cfg'],
  [/^STM32U0/i, 'target/stm32u0x.cfg'],
  [/^STM32U3/i, 'target/stm32u3x.cfg'],
  [/^STM32U5/i, 'target/stm32u5x.cfg'],
  [/^STM32WBA2/i, 'target/stm32wba2x.cfg'],
  [/^STM32WBA5/i, 'target/stm32wba5x.cfg'],
  [/^STM32WBA6/i, 'target/stm32wba6x.cfg'],
  [/^STM32WB/i, 'target/stm32wbx.cfg'],
  [/^STM32WL/i, 'target/stm32wlx.cfg']
];

export function stm32TargetFor(mcuOrFamily: string | undefined): string | undefined {
  if (!mcuOrFamily) {
    return undefined;
  }
  return FAMILY_TARGETS.find(([pattern]) => pattern.test(mcuOrFamily))?.[1];
}
