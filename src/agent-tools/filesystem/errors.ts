export type FilesystemToolErrorCode =
  | 'filesystem_invalid_arguments'
  | 'filesystem_root_not_found'
  | 'filesystem_root_read_only'
  | 'filesystem_root_scope_mismatch'
  | 'filesystem_invalid_root'
  | 'filesystem_invalid_path'
  | 'filesystem_path_escape'
  | 'filesystem_symlink_escape'
  | 'filesystem_broken_symlink'
  | 'filesystem_not_found'
  | 'filesystem_not_file'
  | 'filesystem_not_directory'
  | 'filesystem_not_empty'
  | 'filesystem_already_exists'
  | 'filesystem_conflict'
  | 'filesystem_binary_file'
  | 'filesystem_too_large'
  | 'filesystem_invalid_regex'
  | 'filesystem_edit_not_found'
  | 'filesystem_edit_ambiguous'
  | 'filesystem_unsupported_operation'
  | 'filesystem_io_error';

export class FilesystemToolError extends Error {
  constructor(
    readonly code: FilesystemToolErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'FilesystemToolError';
  }
}

export function filesystemError(
  code: FilesystemToolErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): never {
  throw new FilesystemToolError(code, message, details);
}
