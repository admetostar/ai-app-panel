import * as setup from './global-setup';

export default async function globalSetup(): Promise<void> {
  try {
    await setup.setup();
  } catch (error) {
    try {
      await setup.teardown();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'E2E setup failed and cleanup also failed');
    }
    throw error;
  }
}
