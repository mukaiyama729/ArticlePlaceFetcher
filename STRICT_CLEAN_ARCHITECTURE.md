以下は、**Node.js + Express + Inversify で厳密な Clean Architecture を実装する場合のまとめ**です。

結論から言うと、構造はこれです。

```txt
Router / Composition Root
  ├─ Controller
  └─ Presenter

Controller
  ↓
UseCase interface

Interactor
  ↓
Repository interface
  ↓
OutputBoundary interface

Presenter
  ↓
HTTP Response
```

重要なのは、**Controller が Presenter を知らない**ことです。

---

# 1. 依存関係のルール

厳密にやるなら、依存方向はこうします。

```txt
domain
  ↑
application
  ↑
adapter
  ↑
main
```

つまり、内側は外側を知らない。

```txt
domain      → 何にも依存しない
application → domain のみ知ってよい
adapter     → application / domain を知ってよい
main        → 全部を組み立ててよい
```

逆に、これは禁止です。

```txt
domain      → express
application → express
application → prisma
application → zod
```

## DI の実装方針

DI は **Inversify を使って `main/di` に集約**します。

```txt
main/di
  ├─ types.ts      Inversify の service identifier
  └─ container.ts  binding と composition root
```

アプリケーション起動時に必要な具象クラスの生成は `container.ts` の binding 経由で行い、entry point や adapter から依存オブジェクトを手動で組み立てないようにします。

DI 対象のクラスには Inversify の `@injectable()` / `@inject()` を使い、constructor injection で依存を受け取ります。interface や設定値の注入 token は `main/di/types.ts` に集約します。

`container.get()` は composition root の責務なので、基本的に `main/di` と entry point 境界に閉じ込めます。adapter / application / domain の通常処理から直接 container を引かないでください。

```txt
OK: main/di/container.ts → inversify
OK: DI 対象クラス → @injectable() / @inject(TYPES...)
OK: main/di/container.ts → application / adapter / domain を binding する

NG: adapter 内で container.get() を多用する
NG: entry point で依存グラフを new で手組みする
```

---

# 2. 全体ディレクトリ構成

```txt
src/
  domain/
    user/
      user.ts

  application/
    user/
      dto/
        create-user.dto.ts

      port/
        in/
          create-user-use-case.ts

        out/
          create-user-output-boundary.ts
          user-repository.ts

      service/
        create-user-interactor.ts

  adapter/
    inbound/
      http/
        user/
          controller/
            user-controller.ts

          route/
            user-route.ts

          schema/
            create-user-request.schema.ts

    outbound/
      http/
        user/
          presenter/
            create-user-http-presenter.ts

          view-model/
            create-user-response.ts

      persistence/
        user/
          user-repository-impl.ts

  main/
    di/
      types.ts
      container.ts
      request-context/
        create-user-request-context.ts

    server.ts
```

役割はこうです。

```txt
domain/
  ビジネスルールそのもの

application/
  use case, port, input/output dto

adapter/inbound/http/
  HTTP request を use case input に変換する

adapter/outbound/http/
  use case output を HTTP response に変換する

adapter/outbound/persistence/
  DB, Prisma, TypeORM, DynamoDB など

main/
  DI, Express 起動, composition root
```

---

# 3. Domain

```ts
// src/domain/user/user.ts

import { randomUUID } from 'crypto';

export class User {
  private constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly email: string,
  ) {}

  static create(params: { name: string; email: string }): User {
    return new User(randomUUID(), params.name, params.email);
  }
}
```

`domain` は Express も Inversify も DB も知りません。

---

# 4. Application DTO

```ts
// src/application/user/dto/create-user.dto.ts

export type CreateUserInputData = {
  name: string;
  email: string;
};

export type CreateUserOutputData = {
  userId: string;
  name: string;
  email: string;
};

export type CreateUserErrorOutputData = {
  code: string;
  message: string;
};
```

ここも HTTP に依存しません。

なので、`statusCode` や `res.json()` は出てきません。

---

# 5. UseCase interface

```ts
// src/application/user/port/in/create-user-use-case.ts

import { CreateUserInputData } from '../../dto/create-user.dto';

export interface CreateUserUseCase {
  execute(inputData: CreateUserInputData): Promise<void>;
}
```

戻り値は返さず、結果は `OutputBoundary` に渡します。

これが Presenter パターン寄りの Clean Architecture です。

---

# 6. OutputBoundary interface

```ts
// src/application/user/port/out/create-user-output-boundary.ts

import {
  CreateUserErrorOutputData,
  CreateUserOutputData,
} from '../../dto/create-user.dto';

export interface CreateUserOutputBoundary {
  presentCreated(outputData: CreateUserOutputData): void;

  presentEmailAlreadyExists(outputData: CreateUserErrorOutputData): void;
}
```

use case は `Presenter` そのものではなく、この interface だけを知ります。

---

# 7. Repository interface

```ts
// src/application/user/port/out/user-repository.ts

import { User } from '../../../../domain/user/user';

export interface UserRepository {
  existsByEmail(email: string): Promise<boolean>;

  save(user: User): Promise<User>;
}
```

DB 実装は application 層には置きません。

---

# 8. Interactor

```ts
// src/application/user/service/create-user-interactor.ts

import { inject, injectable } from 'inversify';
import { TYPES } from '../../../main/di/types';
import { User } from '../../../domain/user/user';
import {
  CreateUserErrorOutputData,
  CreateUserInputData,
  CreateUserOutputData,
} from '../dto/create-user.dto';
import { CreateUserUseCase } from '../port/in/create-user-use-case';
import { CreateUserOutputBoundary } from '../port/out/create-user-output-boundary';
import { UserRepository } from '../port/out/user-repository';

@injectable()
export class CreateUserInteractor implements CreateUserUseCase {
  constructor(
    @inject(TYPES.UserRepository)
    private readonly userRepository: UserRepository,

    @inject(TYPES.CreateUserOutputBoundary)
    private readonly outputBoundary: CreateUserOutputBoundary,
  ) {}

  async execute(inputData: CreateUserInputData): Promise<void> {
    const exists = await this.userRepository.existsByEmail(inputData.email);

    if (exists) {
      const outputData: CreateUserErrorOutputData = {
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'email already exists',
      };

      this.outputBoundary.presentEmailAlreadyExists(outputData);
      return;
    }

    const user = User.create({
      name: inputData.name,
      email: inputData.email,
    });

    const savedUser = await this.userRepository.save(user);

    const outputData: CreateUserOutputData = {
      userId: savedUser.id,
      name: savedUser.name,
      email: savedUser.email,
    };

    this.outputBoundary.presentCreated(outputData);
  }
}
```

ここで use case は、

```txt
Repository interface
OutputBoundary interface
```

だけを知ります。

`CreateUserHttpPresenter` は知りません。

---

# 9. HTTP Request Schema

```ts
// src/adapter/inbound/http/user/schema/create-user-request.schema.ts

import { z } from 'zod';

export const createUserRequestSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
```

`zod` は HTTP adapter 側に置きます。

application 層に置かない方が綺麗です。

---

# 10. Controller

```ts
// src/adapter/inbound/http/user/controller/user-controller.ts

import { inject, injectable } from 'inversify';
import { TYPES } from '../../../../../main/di/types';
import { CreateUserUseCase } from '../../../../../application/user/port/in/create-user-use-case';
import { CreateUserRequest } from '../schema/create-user-request.schema';

@injectable()
export class UserController {
  constructor(
    @inject(TYPES.CreateUserUseCase)
    private readonly createUserUseCase: CreateUserUseCase,
  ) {}

  async createUser(request: CreateUserRequest): Promise<void> {
    await this.createUserUseCase.execute({
      name: request.name,
      email: request.email,
    });
  }
}
```

Controller の責務はこれだけです。

```txt
HTTP Request DTO
  ↓
UseCase InputData
  ↓
UseCase 実行
```

ここでは **Presenter を参照しません**。

---

# 11. HTTP ViewModel

```ts
// src/adapter/outbound/http/user/view-model/create-user-response.ts

export type CreateUserResponse = {
  userId: string;
  name: string;
  email: string;
};
```

これは HTTP レスポンス用なので、application 層ではなく adapter 層です。

---

# 12. Presenter

```ts
// src/adapter/outbound/http/user/presenter/create-user-http-presenter.ts

import { injectable } from 'inversify';
import { CreateUserOutputBoundary } from '../../../../../application/user/port/out/create-user-output-boundary';
import {
  CreateUserErrorOutputData,
  CreateUserOutputData,
} from '../../../../../application/user/dto/create-user.dto';
import { CreateUserResponse } from '../view-model/create-user-response';

type HttpSuccessResult<T> = {
  ok: true;
  statusCode: number;
  body: T;
};

type HttpErrorResult = {
  ok: false;
  statusCode: number;
  body: {
    code: string;
    message: string;
  };
};

export type HttpResult<T> = HttpSuccessResult<T> | HttpErrorResult;

@injectable()
export class CreateUserHttpPresenter implements CreateUserOutputBoundary {
  private resultValue: HttpResult<CreateUserResponse> | null = null;

  get result(): HttpResult<CreateUserResponse> {
    if (this.resultValue === null) {
      throw new Error('Presenter result is not set');
    }

    return this.resultValue;
  }

  presentCreated(outputData: CreateUserOutputData): void {
    this.resultValue = {
      ok: true,
      statusCode: 201,
      body: {
        userId: outputData.userId,
        name: outputData.name,
        email: outputData.email,
      },
    };
  }

  presentEmailAlreadyExists(outputData: CreateUserErrorOutputData): void {
    this.resultValue = {
      ok: false,
      statusCode: 409,
      body: {
        code: outputData.code,
        message: outputData.message,
      },
    };
  }
}
```

Presenter は、

```txt
application output data
  ↓
HTTP response model
```

に変換する責務だけを持ちます。

---

# 13. Repository 実装

```ts
// src/adapter/outbound/persistence/user/user-repository-impl.ts

import { injectable } from 'inversify';
import { User } from '../../../../domain/user/user';
import { UserRepository } from '../../../../application/user/port/out/user-repository';

@injectable()
export class UserRepositoryImpl implements UserRepository {
  async existsByEmail(email: string): Promise<boolean> {
    // Prisma / TypeORM / raw SQL などで実装
    return false;
  }

  async save(user: User): Promise<User> {
    // DB 保存処理
    return user;
  }
}
```

Prisma を使う場合も、Prisma client はここに閉じ込めます。

```txt
application → Prisma
```

にはしません。

---

# 14. TYPES

```ts
// src/main/di/types.ts

export const TYPES = {
  UserController: Symbol.for('UserController'),

  CreateUserUseCase: Symbol.for('CreateUserUseCase'),
  CreateUserOutputBoundary: Symbol.for('CreateUserOutputBoundary'),
  CreateUserHttpPresenter: Symbol.for('CreateUserHttpPresenter'),

  UserRepository: Symbol.for('UserRepository'),

  CreateUserRequestContext: Symbol.for('CreateUserRequestContext'),
};
```

---

# 15. RequestContext

ここがかなり重要です。

```ts
// src/main/di/request-context/create-user-request-context.ts

import { inject, injectable } from 'inversify';
import { TYPES } from '../types';
import { UserController } from '../../../adapter/inbound/http/user/controller/user-controller';
import { CreateUserHttpPresenter } from '../../../adapter/outbound/http/user/presenter/create-user-http-presenter';

@injectable()
export class CreateUserRequestContext {
  constructor(
    @inject(TYPES.UserController)
    public readonly controller: UserController,

    @inject(TYPES.CreateUserHttpPresenter)
    public readonly presenter: CreateUserHttpPresenter,
  ) {}
}
```

なぜこれが必要かというと、Inversify の `inRequestScope()` は **HTTP リクエスト単位ではなく、1 回の `container.get()` の解決ツリー単位**だからです。

つまり、これは危険です。

```ts
const controller = container.get<UserController>(TYPES.UserController);
const presenter = container.get<CreateUserHttpPresenter>(
  TYPES.CreateUserHttpPresenter,
);
```

`container.get()` が 2 回あるので、同じ presenter インスタンスになる保証が弱いです。

そのため、必ずこれを 1 回だけ呼びます。

```ts
const context = container.get<CreateUserRequestContext>(
  TYPES.CreateUserRequestContext,
);
```

これで、

```txt
context.controller
context.presenter
interactor に注入される outputBoundary
```

が同じ解決ツリー内で作られます。

---

# 16. Container

```ts
// src/main/di/container.ts

import 'reflect-metadata';
import { Container } from 'inversify';
import { TYPES } from './types';

import { UserController } from '../../adapter/inbound/http/user/controller/user-controller';
import { CreateUserInteractor } from '../../application/user/service/create-user-interactor';
import { CreateUserUseCase } from '../../application/user/port/in/create-user-use-case';
import { CreateUserOutputBoundary } from '../../application/user/port/out/create-user-output-boundary';
import { CreateUserHttpPresenter } from '../../adapter/outbound/http/user/presenter/create-user-http-presenter';
import { UserRepository } from '../../application/user/port/out/user-repository';
import { UserRepositoryImpl } from '../../adapter/outbound/persistence/user/user-repository-impl';
import { CreateUserRequestContext } from './request-context/create-user-request-context';

export const container = new Container();

container.bind<UserController>(TYPES.UserController).to(UserController);

container
  .bind<CreateUserUseCase>(TYPES.CreateUserUseCase)
  .to(CreateUserInteractor);

container.bind<UserRepository>(TYPES.UserRepository).to(UserRepositoryImpl);

container
  .bind<CreateUserHttpPresenter>(TYPES.CreateUserHttpPresenter)
  .to(CreateUserHttpPresenter)
  .inRequestScope();

container
  .bind<CreateUserOutputBoundary>(TYPES.CreateUserOutputBoundary)
  .toService(TYPES.CreateUserHttpPresenter);

container
  .bind<CreateUserRequestContext>(TYPES.CreateUserRequestContext)
  .to(CreateUserRequestContext);
```

ポイントはここです。

```ts
container
  .bind<CreateUserHttpPresenter>(TYPES.CreateUserHttpPresenter)
  .to(CreateUserHttpPresenter)
  .inRequestScope();
```

Presenter は状態を持つため、singleton にしてはいけません。

NG です。

```ts
container
  .bind<CreateUserHttpPresenter>(TYPES.CreateUserHttpPresenter)
  .to(CreateUserHttpPresenter)
  .inSingletonScope();
```

リクエスト間で `resultValue` が共有されてしまう危険があります。

---

# 17. Express Route

```ts
// src/adapter/inbound/http/user/route/user-route.ts

import { Router } from 'express';
import { container } from '../../../../../main/di/container';
import { TYPES } from '../../../../../main/di/types';
import { CreateUserRequestContext } from '../../../../../main/di/request-context/create-user-request-context';
import { createUserRequestSchema } from '../schema/create-user-request.schema';

export const userRoute = Router();

userRoute.post('/users', async (req, res, next) => {
  try {
    const parsed = createUserRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'invalid request body',
        issues: parsed.error.issues,
      });
    }

    const context = container.get<CreateUserRequestContext>(
      TYPES.CreateUserRequestContext,
    );

    await context.controller.createUser(parsed.data);

    const result = context.presenter.result;

    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    return next(error);
  }
});
```

ここで初めて presenter を参照します。

ただし、参照しているのは **controller ではなく router** です。

```txt
router → controller
router → presenter
controller → use case
use case → output boundary
presenter → output boundary implementation
```

この形なら、controller が presenter に依存しません。

---

# 18. Server

```ts
// src/main/server.ts

import express from 'express';
import { userRoute } from '../adapter/inbound/http/user/route/user-route';

const app = express();

app.use(express.json());

app.use(userRoute);

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error(err);

    return res.status(500).json({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'internal server error',
    });
  },
);

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
```

---

# 19. tsconfig

Inversify の decorator を使うなら、だいたいこれが必要です。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true
  }
}
```

また、どこかの entry point でこれを読み込みます。

```ts
import 'reflect-metadata';
```

今回の例では `container.ts` で読み込んでいます。

---

# 20. この設計の流れ

実行時の流れはこうです。

```txt
POST /users
  ↓
Express Router
  ↓
Zod validation
  ↓
CreateUserRequestContext を container.get()
  ↓
context.controller.createUser()
  ↓
UserController
  ↓
CreateUserUseCase.execute()
  ↓
CreateUserInteractor
  ↓
UserRepository
  ↓
CreateUserOutputBoundary.presentCreated()
  ↓
CreateUserHttpPresenter に result がセットされる
  ↓
Router が context.presenter.result を取得
  ↓
res.status(...).json(...)
```

---

# 21. 依存関係を図にすると

```txt
[main]
  container.ts
  server.ts
      ↓
[adapter/inbound/http]
  route
  controller
      ↓
[application]
  use case interface
  interactor
  output boundary interface
  repository interface
      ↓
[domain]
  entity
```

Presenter は outbound adapter です。

```txt
[adapter/outbound/http]
  presenter
      ↓ implements
[application]
  output boundary interface
```

Repository 実装も outbound adapter です。

```txt
[adapter/outbound/persistence]
  repository impl
      ↓ implements
[application]
  repository interface
```

---

# 22. Controller と Presenter の責務

## Controller

やること。

```txt
HTTP request DTO を受け取る
application input DTO に変換する
use case を呼ぶ
```

やらないこと。

```txt
DBアクセス
ビジネスロジック
HTTPレスポンス生成
Presenter参照
statusCode決定
```

---

## Presenter

やること。

```txt
application output data を受け取る
HTTP response body に変換する
statusCode を決める
```

やらないこと。

```txt
DBアクセス
ビジネスロジック
request validation
use case 呼び出し
```

---

## Router

やること。

```txt
Express の req/res を扱う
validation error を返す
controller を呼ぶ
presenter.result を res に流す
```

Router は framework glue なので、Express や concrete presenter を知っていてよいです。

---

# 23. 実装時の判断基準

迷ったらこう考えるとよいです。

## application 層に置くもの

```txt
ビジネスルール
use case
interface
input/output data
```

例：

```txt
CreateUserUseCase
CreateUserInteractor
CreateUserInputData
CreateUserOutputData
UserRepository interface
CreateUserOutputBoundary interface
```

---

## adapter 層に置くもの

```txt
外部世界との変換
HTTP
DB
外部API
Queue
Cache
File
```

例：

```txt
UserController
CreateUserHttpPresenter
UserRepositoryImpl
CreateUserRequestSchema
CreateUserResponse
```

---

## main 層に置くもの

```txt
DI
server起動
router登録
middleware登録
環境変数読み込み
```

例：

```txt
container.ts
server.ts
types.ts
request-context.ts
```

---

# 24. よくある NG

## NG 1: Controller が Presenter を直接知る

```ts
class UserController {
  constructor(
    private readonly useCase: CreateUserUseCase,
    private readonly presenter: CreateUserHttpPresenter,
  ) {}
}
```

これは避ける。

Controller と Presenter はどちらも adapter なので、接続は router / composition root 側で行う方が綺麗です。

---

## NG 2: UseCase が HTTP を返す

```ts
return {
  statusCode: 201,
  body: { ... },
};
```

これは application 層が HTTP を知っているので避けます。

---

## NG 3: application 層で Express の型を使う

```ts
execute(req: Request): Promise<Response>
```

これは完全に外側依存です。

---

## NG 4: Presenter を Singleton にする

```ts
.inSingletonScope()
```

Presenter は状態を持つので危険です。

必ず request scope 相当にします。

---

## NG 5: `container.get()` を route 内で複数回呼ぶ

```ts
const controller = container.get<UserController>(TYPES.UserController);
const presenter = container.get<CreateUserHttpPresenter>(
  TYPES.CreateUserHttpPresenter,
);
```

同一インスタンス保証が弱くなるので、`RequestContext` を 1 回だけ resolve する方が安全です。

---

# 25. まとめ

厳密な Clean Architecture で Node.js + Inversify を使うなら、基本形はこれです。

```txt
Controller は Presenter を知らない
UseCase は OutputBoundary interface だけ知る
Presenter は OutputBoundary を実装する
Repository は interface を application に置く
DB 実装は adapter/outbound/persistence に置く
Router / RequestContext が Controller と Presenter を接続する
DI は main に閉じ込める
```

最重要ポイントはこれです。

```ts
const context = container.get<CreateUserRequestContext>(
  TYPES.CreateUserRequestContext,
);
```

1 リクエストごとに `RequestContext` を 1 回だけ resolve し、その中に、

```txt
controller
presenter
use case
output boundary
```

をまとめて作る。

これにより、

```txt
controller は presenter を知らない
use case は concrete presenter を知らない
router は HTTP response を返せる
```

という、かなり厳密な Clean Architecture になります。
