// Shared types for the security questions (client and server).

export type SecurityQuestionOption = {
  id: number;
  question: string;
};

export type SecurityQuestionAnswerInput = {
  questionId: number;
  answer: string;
};
