/**
 * Re-export the schema package plus zod through one server-side module, so route
 * handlers import validation from a single place.
 */
export { z } from 'zod';
export * from '@wdv/schema';
