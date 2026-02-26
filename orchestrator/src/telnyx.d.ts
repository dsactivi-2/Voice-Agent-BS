declare module 'telnyx' {
  interface CallCreateParams {
    connection_id: string;
    to: string;
    from: string;
    webhook_url?: string;
    stream_url?: string;
    answering_machine_detection?: string;
    answering_machine_detection_config?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface CallResponse {
    data: {
      call_control_id: string;
      call_leg_id: string;
      call_session_id: string;
      is_alive: boolean;
      record_type: string;
      [key: string]: unknown;
    };
  }

  interface Calls {
    create(params: CallCreateParams): Promise<CallResponse>;
  }

  interface TelnyxInstance {
    calls: Calls;
  }

  class Telnyx {
    constructor(apiKey: string);
    calls: Calls;
  }

  export default Telnyx;
}
