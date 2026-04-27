<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Database Migrations (Supabase)

When creating or modifying a database migration file in `supabase/migrations/`, you must take the migration end-to-end:

1. **Create the migration file** in `supabase/migrations/` with the next sequential number.
2. **Link the project** (if not already linked):
   ```
   npx supabase link --project-ref jhtrpaplixdjwepyings
   ```
3. **Apply the migration** to the remote database:
   ```
   npx supabase db push
   ```
4. **Verify the migration** was applied correctly:
   ```
   npx supabase db query --linked "<verification SQL>"
   ```
5. **Regenerate TypeScript types** from the updated remote schema:
   ```
   npx supabase gen types --linked --lang=typescript > lib/supabase/types.ts
   ```

6. **Preserve convenience type aliases** at the bottom of `lib/supabase/types.ts`. The generator overwrites the file, so re-add the aliases (e.g. `export type Project = ...`) after regenerating. Check the git diff to see what was lost.
7. **Fix any TypeScript errors** introduced by the regenerated types. Run `npx tsc --noEmit` and fix all errors before committing.

Never stop at just creating the migration file. The types in `lib/supabase/types.ts` must always reflect the current database schema.
