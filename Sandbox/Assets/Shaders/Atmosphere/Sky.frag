#version 450
#extension GL_ARB_separate_shader_objects : enable


////////////
// Util.h //
////////////


const float PI = 3.14159265358979323846;

float ClampCosine(float mu) {
    return clamp(mu, -1.0, 1.0);
}

float ClampDistance(float d) {
    return max(d, 0.0);
}

float SafeSqrt(float area) {
    return sqrt(max(area, 0.0));
}

float GetTextureCoordFromUnitRange(float x, int texture_size) {
    return 0.5 / float(texture_size) + x * (1.0 - 1.0 / float(texture_size));
}

float GetUnitRangeFromTextureCoord(float u, int texture_size) {
    return (u - 0.5 / float(texture_size)) / (1.0 - 1.0 / float(texture_size));
}

float RayleighPhaseFunction(float nu) {
    float k = 3.0 / (16.0 * PI);
    return k * (1.0 + nu * nu);
}

float MiePhaseFunction(float g, float nu) {
    float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
    return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

float GetFragCoordFromTexel(uint x, uint texture_size) {
    return texture_size * GetTextureCoordFromUnitRange(x / float(texture_size - 1), int(texture_size));
}

vec3 GetFragCoordFromTexel(uvec3 v, uvec3 size) {
    return vec3(
        GetFragCoordFromTexel(v.x, size.x),
        GetFragCoordFromTexel(v.y, size.y),
        GetFragCoordFromTexel(v.z, size.z));
}


//////////////
// Params.h //
//////////////


// An atmosphere layer of width 'width', and whose density is defined as
//   'exp_term' * exp('exp_scale' * h) + 'linear_term' * h + 'constant_term',
// clamped to [0,1], and where h is the altitude.
struct DensityProfileLayer {
    float width;
    float exp_term;
    float exp_scale;
    float linear_term;
    float constant_term;
};

// An atmosphere density profile made of several layers on top of each other
// (from bottom to top). The width of the last layer is ignored, i.e. it always
// extend to the top atmosphere boundary. The profile values vary between 0
// (null density) to 1 (maximum density).
struct DensityProfile {
    DensityProfileLayer layers[2];
};

// Fields ordered for density
struct AtmosphereParameters {
    // The solar irradiance at the top of the atmosphere.
    vec3 solar_irradiance;
    // The sun's angular radius. Warning: the implementation uses approximations
    // that are valid only if this angle is smaller than 0.1 radians.
    float sun_angular_radius;
    // The scattering coefficient of air molecules at the altitude where their
    // density is maximum (usually the bottom of the atmosphere), as a function of
    // wavelength. The scattering coefficient at altitude h is equal to
    // 'rayleigh_scattering' times 'rayleigh_density' at this altitude.
    vec3 rayleigh_scattering;
    // The distance between the planet center and the bottom of the atmosphere.
    float bottom_radius;
    // The scattering coefficient of aerosols at the altitude where their density
    // is maximum (usually the bottom of the atmosphere), as a function of
    // wavelength. The scattering coefficient at altitude h is equal to
    // 'mie_scattering' times 'mie_density' at this altitude.
    vec3 mie_scattering;
    // The distance between the planet center and the top of the atmosphere.
    float top_radius;
    // The extinction coefficient of aerosols at the altitude where their density
    // is maximum (usually the bottom of the atmosphere), as a function of
    // wavelength. The extinction coefficient at altitude h is equal to
    // 'mie_extinction' times 'mie_density' at this altitude.
    vec3 mie_extinction;
    // The asymetry parameter for the Cornette-Shanks phase function for the
    // aerosols.
    float mie_phase_function_g;
    // The average albedo of the ground.
    vec3 ground_albedo;
    // The cosine of the maximum Sun zenith angle for which atmospheric scattering
    // must be precomputed (for maximum precision, use the smallest Sun zenith
    // angle yielding negligible sky light radiance values. For instance, for the
    // Earth case, 102 degrees is a good choice - yielding mu_s_min = -0.2).
    float mu_s_min;
    // The extinction coefficient of molecules that absorb light (e.g. ozone) at
    // the altitude where their density is maximum, as a function of wavelength.
    // The extinction coefficient at altitude h is equal to
    // 'absorption_extinction' times 'absorption_density' at this altitude.
    vec3 absorption_extinction;

    // Texture size parameters
    int transmittance_texture_mu_size;
    int transmittance_texture_r_size;
    int scattering_texture_r_size;
    int scattering_texture_mu_size;
    int scattering_texture_mu_s_size;
    int scattering_texture_nu_size;
    int irradiance_texture_mu_s_size;
    int irradiance_texture_r_size;

    // The density profile of air molecules, i.e. a function from altitude to
    // dimensionless values between 0 (null density) and 1 (maximum density).
    DensityProfile rayleigh_density;
    // The density profile of aerosols, i.e. a function from altitude to
    // dimensionless values between 0 (null density) and 1 (maximum density).
    DensityProfile mie_density;
    // The density profile of air molecules that absorb light (e.g. ozone), i.e.
    // a function from altitude to dimensionless values between 0 (null density)
    // and 1 (maximum density).
    DensityProfile absorption_density;
};

float GetLayerDensity(DensityProfileLayer layer, float altitude) {
    float density = layer.exp_term * exp(layer.exp_scale * altitude) +
        layer.linear_term * altitude + layer.constant_term;
    return clamp(density, 0.0, 1.0);
}

float GetProfileDensity(DensityProfile profile, float altitude) {
    return altitude < profile.layers[0].width ?
        GetLayerDensity(profile.layers[0], altitude) :
        GetLayerDensity(profile.layers[1], altitude);
}

float ClampRadius(AtmosphereParameters atmosphere, float r) {
    return clamp(r, atmosphere.bottom_radius, atmosphere.top_radius);
}

float DistanceToTopAtmosphereBoundary(AtmosphereParameters atmosphere, float r, float mu) {
    // assert(r <= atmosphere.top_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    float discriminant = r * r * (mu * mu - 1.0) + atmosphere.top_radius * atmosphere.top_radius;
    return ClampDistance(-r * mu + SafeSqrt(discriminant));
}

float DistanceToBottomAtmosphereBoundary(AtmosphereParameters atmosphere, float r, float mu) {
    // assert(r >= atmosphere.bottom_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    float discriminant = r * r * (mu * mu - 1.0) + atmosphere.bottom_radius * atmosphere.bottom_radius;
    return ClampDistance(-r * mu - SafeSqrt(discriminant));
}

bool RayIntersectsGround(AtmosphereParameters atmosphere, float r, float mu) {
    // assert(r >= atmosphere.bottom_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    return mu < 0.0 && r * r * (mu * mu - 1.0) +
        atmosphere.bottom_radius * atmosphere.bottom_radius >= 0.0;
}

float DistanceToNearestAtmosphereBoundary(AtmosphereParameters atmosphere,
                                          float r, float mu, bool ray_r_mu_intersects_ground) {
    if (ray_r_mu_intersects_ground) {
        return DistanceToBottomAtmosphereBoundary(atmosphere, r, mu);
    } else {
        return DistanceToTopAtmosphereBoundary(atmosphere, r, mu);
    }
}


/////////////////////
// Transmittance.h //
/////////////////////


vec2 GetTransmittanceTextureUvFromRMu(AtmosphereParameters atmosphere, float r, float mu) {
    // assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    // Distance to top atmosphere boundary for a horizontal ray at ground level.
    float H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
                   atmosphere.bottom_radius * atmosphere.bottom_radius);
    // Distance to the horizon.
    float rho = SafeSqrt(r * r - atmosphere.bottom_radius * atmosphere.bottom_radius);
    // Distance to the top atmosphere boundary for the ray (r,mu), and its minimum
    // and maximum values over all mu - obtained for (r,1) and (r,mu_horizon).
    float d = DistanceToTopAtmosphereBoundary(atmosphere, r, mu);
    float d_min = atmosphere.top_radius - r;
    float d_max = rho + H;
    float x_mu = (d - d_min) / (d_max - d_min);
    float x_r = rho / H;
    return vec2(GetTextureCoordFromUnitRange(x_mu, atmosphere.transmittance_texture_mu_size),
                GetTextureCoordFromUnitRange(x_r, atmosphere.transmittance_texture_r_size));
}

vec3 GetTransmittanceToTopAtmosphereBoundary(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    float r, float mu) {
    // assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
    vec2 uv = GetTransmittanceTextureUvFromRMu(atmosphere, r, mu);
    return texture(transmittance_texture, uv).rgb;
}

vec3 GetTransmittance(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    float r, float mu, float d, bool ray_r_mu_intersects_ground) {
    // assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    // assert(d >= 0.0 * m);

    float r_d = ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
    float mu_d = ClampCosine((r * mu + d) / r_d);

    vec3 quotient;
    if (ray_r_mu_intersects_ground) {
        quotient =
            GetTransmittanceToTopAtmosphereBoundary(
                atmosphere, transmittance_texture, r_d, -mu_d) /
            GetTransmittanceToTopAtmosphereBoundary(
                atmosphere, transmittance_texture, r, -mu);
    } else {
        quotient =
            GetTransmittanceToTopAtmosphereBoundary(
                atmosphere, transmittance_texture, r, mu) /
            GetTransmittanceToTopAtmosphereBoundary(
                atmosphere, transmittance_texture, r_d, mu_d);
    }
    return min(quotient, vec3(1.0));
}

vec3 GetTransmittanceToSun(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    float r, float mu_s) {
    float sin_theta_h = atmosphere.bottom_radius / r;
    float cos_theta_h = -sqrt(max(1.0 - sin_theta_h * sin_theta_h, 0.0));
    return GetTransmittanceToTopAtmosphereBoundary(
        atmosphere, transmittance_texture, r, mu_s) *
        smoothstep(-sin_theta_h * atmosphere.sun_angular_radius,
                   sin_theta_h * atmosphere.sun_angular_radius,
                   mu_s - cos_theta_h);
}


//////////////////
// Scattering.h //
//////////////////


vec4 GetScatteringTextureUvwzFromRMuMuSNu(AtmosphereParameters atmosphere,
                                          float r, float mu, float mu_s, float nu,
                                          bool ray_r_mu_intersects_ground) {
    // assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
    // assert(mu >= -1.0 && mu <= 1.0);
    // assert(mu_s >= -1.0 && mu_s <= 1.0);
    // assert(nu >= -1.0 && nu <= 1.0);

    // Distance to top atmosphere boundary for a horizontal ray at ground level.
    float H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
                   atmosphere.bottom_radius * atmosphere.bottom_radius);
    // Distance to the horizon.
    float rho =
        SafeSqrt(r * r - atmosphere.bottom_radius * atmosphere.bottom_radius);
    float u_r = GetTextureCoordFromUnitRange(rho / H, atmosphere.scattering_texture_r_size);

    // Discriminant of the quadratic equation for the intersections of the ray
    // (r,mu) with the ground (see RayIntersectsGround).
    float r_mu = r * mu;
    float discriminant =
        r_mu * r_mu - r * r + atmosphere.bottom_radius * atmosphere.bottom_radius;
    float u_mu;
    if (ray_r_mu_intersects_ground) {
        // Distance to the ground for the ray (r,mu), and its minimum and maximum
        // values over all mu - obtained for (r,-1) and (r,mu_horizon).
        float d = -r_mu - SafeSqrt(discriminant);
        float d_min = r - atmosphere.bottom_radius;
        float d_max = rho;
        u_mu = 0.5 - 0.5 * GetTextureCoordFromUnitRange(d_max == d_min ? 0.0 :
                                                        (d - d_min) / (d_max - d_min), atmosphere.scattering_texture_mu_size / 2);
    } else {
        // Distance to the top atmosphere boundary for the ray (r,mu), and its
        // minimum and maximum values over all mu - obtained for (r,1) and
        // (r,mu_horizon).
        float d = -r_mu + SafeSqrt(discriminant + H * H);
        float d_min = atmosphere.top_radius - r;
        float d_max = rho + H;
        u_mu = 0.5 + 0.5 * GetTextureCoordFromUnitRange(
            (d - d_min) / (d_max - d_min), atmosphere.scattering_texture_mu_size / 2);
    }

    float d = DistanceToTopAtmosphereBoundary(
        atmosphere, atmosphere.bottom_radius, mu_s);
    float d_min = atmosphere.top_radius - atmosphere.bottom_radius;
    float d_max = H;
    float a = (d - d_min) / (d_max - d_min);
    float A =
        -2.0 * atmosphere.mu_s_min * atmosphere.bottom_radius / (d_max - d_min);
    float u_mu_s = GetTextureCoordFromUnitRange(
        max(1.0 - a / A, 0.0) / (1.0 + a), atmosphere.scattering_texture_mu_s_size);

    float u_nu = (nu + 1.0) / 2.0;
    return vec4(u_nu, u_mu_s, u_mu, u_r);
}

void GetRMuMuSNuFromScatteringTextureUvwz(AtmosphereParameters atmosphere,
                                          vec4 uvwz, out float r, out float mu, out float mu_s,
                                          out float nu, out bool ray_r_mu_intersects_ground) {
    // assert(uvwz.x >= 0.0 && uvwz.x <= 1.0);
    // assert(uvwz.y >= 0.0 && uvwz.y <= 1.0);
    // assert(uvwz.z >= 0.0 && uvwz.z <= 1.0);
    // assert(uvwz.w >= 0.0 && uvwz.w <= 1.0);

    // Distance to top atmosphere boundary for a horizontal ray at ground level.
    float H = sqrt(atmosphere.top_radius * atmosphere.top_radius -
                   atmosphere.bottom_radius * atmosphere.bottom_radius);
    // Distance to the horizon.
    float rho =
        H * GetUnitRangeFromTextureCoord(uvwz.w, atmosphere.scattering_texture_r_size);
    r = sqrt(rho * rho + atmosphere.bottom_radius * atmosphere.bottom_radius);

    if (uvwz.z < 0.5) {
        // Distance to the ground for the ray (r,mu), and its minimum and maximum
        // values over all mu - obtained for (r,-1) and (r,mu_horizon) - from which
        // we can recover mu:
        float d_min = r - atmosphere.bottom_radius;
        float d_max = rho;
        float d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(
            1.0 - 2.0 * uvwz.z, atmosphere.scattering_texture_mu_size / 2);
        mu = d == 0.0 ? -1.0 :
            ClampCosine(-(rho * rho + d * d) / (2.0 * r * d));
        ray_r_mu_intersects_ground = true;
    } else {
        // Distance to the top atmosphere boundary for the ray (r,mu), and its
        // minimum and maximum values over all mu - obtained for (r,1) and
        // (r,mu_horizon) - from which we can recover mu:
        float d_min = atmosphere.top_radius - r;
        float d_max = rho + H;
        float d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(
            2.0 * uvwz.z - 1.0, atmosphere.scattering_texture_mu_size / 2);
        mu = d == 0.0 ? 1.0 :
            ClampCosine((H * H - rho * rho - d * d) / (2.0 * r * d));
        ray_r_mu_intersects_ground = false;
    }

    float x_mu_s =
        GetUnitRangeFromTextureCoord(uvwz.y, atmosphere.scattering_texture_mu_s_size);
    float d_min = atmosphere.top_radius - atmosphere.bottom_radius;
    float d_max = H;
    float A =
        -2.0 * atmosphere.mu_s_min * atmosphere.bottom_radius / (d_max - d_min);
    float a = (A - x_mu_s * A) / (1.0 + x_mu_s * A);
    float d = d_min + min(a, A) * (d_max - d_min);
    mu_s = d == 0.0 ? 1.0 :
        ClampCosine((H * H - d * d) / (2.0 * atmosphere.bottom_radius * d));

    nu = ClampCosine(uvwz.x * 2.0 - 1.0);
}

void GetRMuMuSNuFromScatteringTextureFragCoord(
    AtmosphereParameters atmosphere, vec3 frag_coord,
    out float r, out float mu, out float mu_s, out float nu,
    out bool ray_r_mu_intersects_ground) {
    const vec4 SCATTERING_TEXTURE_SIZE = vec4(
        atmosphere.scattering_texture_nu_size - 1,
        atmosphere.scattering_texture_mu_s_size,
        atmosphere.scattering_texture_mu_size,
        atmosphere.scattering_texture_r_size);
    float frag_coord_nu =
        floor(frag_coord.x / float(atmosphere.scattering_texture_mu_s_size));
    float frag_coord_mu_s =
        mod(frag_coord.x, float(atmosphere.scattering_texture_mu_s_size));
    vec4 uvwz =
        vec4(frag_coord_nu, frag_coord_mu_s, frag_coord.y, frag_coord.z) /
        SCATTERING_TEXTURE_SIZE;
    GetRMuMuSNuFromScatteringTextureUvwz(
        atmosphere, uvwz, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    // Clamp nu to its valid range of values, given mu and mu_s.
    nu = clamp(nu, mu * mu_s - sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)),
               mu * mu_s + sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)));
}

vec3 GetScattering(
    AtmosphereParameters atmosphere,
    sampler3D scattering_texture,
    float r, float mu, float mu_s, float nu,
    bool ray_r_mu_intersects_ground) {
    vec4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(
        atmosphere, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    float tex_coord_x = uvwz.x * float(atmosphere.scattering_texture_nu_size - 1);
    float tex_x = floor(tex_coord_x);
    float lerp = tex_coord_x - tex_x;
    vec3 uvw0 = vec3((tex_x + uvwz.y) / float(atmosphere.scattering_texture_nu_size),
                     uvwz.z, uvwz.w);
    vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / float(atmosphere.scattering_texture_nu_size),
                     uvwz.z, uvwz.w);
    return vec3(texture(scattering_texture, uvw0) * (1.0 - lerp) +
                texture(scattering_texture, uvw1) * lerp);
}

vec3 GetScattering(
    AtmosphereParameters atmosphere,
    sampler3D single_rayleigh_scattering_texture,
    sampler3D single_mie_scattering_texture,
    sampler3D multiple_scattering_texture,
    float r, float mu, float mu_s, float nu,
    bool ray_r_mu_intersects_ground,
    int scattering_order) {
    if (scattering_order == 1) {
        vec3 rayleigh = GetScattering(
            atmosphere, single_rayleigh_scattering_texture, r, mu, mu_s, nu,
            ray_r_mu_intersects_ground);
        vec3 mie = GetScattering(
            atmosphere, single_mie_scattering_texture, r, mu, mu_s, nu,
            ray_r_mu_intersects_ground);
        return rayleigh * RayleighPhaseFunction(nu) +
            mie * MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
    } else {
        return GetScattering(
            atmosphere, multiple_scattering_texture, r, mu, mu_s, nu,
            ray_r_mu_intersects_ground);
    }
}

bool GetScatteringFragCoord(AtmosphereParameters atmosphere, uvec3 id, out vec3 coord) {
    uvec3 ref = uvec3(atmosphere.scattering_texture_nu_size * atmosphere.scattering_texture_mu_s_size,
                      atmosphere.scattering_texture_mu_size,
                      atmosphere.scattering_texture_r_size);
    if (any(greaterThanEqual(id, ref))) {
        return false;
    }
    coord = GetFragCoordFromTexel(id, ref);
    return true;
}


//////////////////
// Irradiance.h //
//////////////////


void GetRMuSFromIrradianceUnitRange(
    AtmosphereParameters atmosphere,
    float x_mu_s, float x_r,
    out float r, out float mu_s) {
    // assert(uv.x >= 0.0 && uv.x <= 1.0);
    // assert(uv.y >= 0.0 && uv.y <= 1.0);
    // Number x_mu_s = GetUnitRangeFromTextureCoord(uv.x, IRRADIANCE_TEXTURE_WIDTH);
    // Number x_r = GetUnitRangeFromTextureCoord(uv.y, IRRADIANCE_TEXTURE_HEIGHT);
    r = atmosphere.bottom_radius +
        x_r * (atmosphere.top_radius - atmosphere.bottom_radius);
    mu_s = ClampCosine(2.0 * x_mu_s - 1.0);
}

vec2 GetIrradianceTextureUvFromRMuS(
    AtmosphereParameters atmosphere,
    float r, float mu_s) {
    // assert(r >= atmosphere.bottom_radius && r <= atmosphere.top_radius);
    // assert(mu_s >= -1.0 && mu_s <= 1.0);
    float x_r = (r - atmosphere.bottom_radius) /
        (atmosphere.top_radius - atmosphere.bottom_radius);
    float x_mu_s = mu_s * 0.5 + 0.5;
    return vec2(GetTextureCoordFromUnitRange(x_mu_s, atmosphere.irradiance_texture_mu_s_size),
                GetTextureCoordFromUnitRange(x_r, atmosphere.irradiance_texture_r_size));
}

vec3 GetIrradiance(
    AtmosphereParameters atmosphere,
    sampler2D irradiance_texture,
    float r, float mu_s) {
    vec2 uv = GetIrradianceTextureUvFromRMuS(atmosphere, r, mu_s);
    return texture(irradiance_texture, uv).rgb;
}


//////////////////////
// RenderLighting.h //
//////////////////////

// Returns direct illumination, last argument outputs indirect illumination
vec3 GetSunAndSkyIrradiance(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    sampler2D irradiance_texture,
    vec3 point, vec3 normal, vec3 sun_direction,
    out vec3 sky_irradiance) {
    float r = length(point);
    float mu_s = dot(point, sun_direction) / r;

    // Indirect irradiance (approximated if the surface is not horizontal).
    sky_irradiance = GetIrradiance(atmosphere, irradiance_texture, r, mu_s) *
        (1.0 + dot(normal, point) / r) * 0.5;

    // Direct irradiance.
    return atmosphere.solar_irradiance *
        GetTransmittanceToSun(
            atmosphere, transmittance_texture, r, mu_s) *
        max(dot(normal, sun_direction), 0.0);
}

///////////
// Sky.h //
///////////


vec3 GetExtrapolatedSingleMieScattering(
    AtmosphereParameters atmosphere, vec4 scattering) {
    // Algebraically this can never be negative, but rounding errors can produce that effect for
    // sufficiently short view rays.
    if (scattering.r <= 0.0) {
        return vec3(0.0);
    }
    return scattering.rgb * scattering.a / scattering.r *
        (atmosphere.rayleigh_scattering.r / atmosphere.mie_scattering.r) *
        (atmosphere.mie_scattering / atmosphere.rayleigh_scattering);
}

vec3 GetCombinedScattering(
    AtmosphereParameters atmosphere,
    sampler3D scattering_texture,
    float r, float mu, float mu_s, float nu,
    bool ray_r_mu_intersects_ground,
    out vec3 single_mie_scattering) {
    vec4 uvwz = GetScatteringTextureUvwzFromRMuMuSNu(
        atmosphere, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    float tex_coord_x = uvwz.x * float(atmosphere.scattering_texture_nu_size - 1);
    float tex_x = floor(tex_coord_x);
    float lerp = tex_coord_x - tex_x;
    vec3 uvw0 = vec3((tex_x + uvwz.y) / float(atmosphere.scattering_texture_nu_size),
                     uvwz.z, uvwz.w);
    vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / float(atmosphere.scattering_texture_nu_size),
                     uvwz.z, uvwz.w);
    vec4 combined_scattering = mix(
        texture(scattering_texture, uvw0),
        texture(scattering_texture, uvw1),
        lerp);
    single_mie_scattering =
        GetExtrapolatedSingleMieScattering(atmosphere, combined_scattering);
    return combined_scattering.rgb;
}

vec3 GetSkyRadiance(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    sampler3D scattering_texture,
    vec3 camera, vec3 view_ray,
    vec3 sun_direction, out vec3 transmittance) {
    // Compute the distance to the top atmosphere boundary along the view ray,
    // assuming the viewer is in space (or NaN if the view ray does not intersect
    // the atmosphere).
    float r = length(camera);
    float rmu = dot(camera, view_ray);
    float distance_to_top_atmosphere_boundary = -rmu -
        sqrt(rmu * rmu - r * r + atmosphere.top_radius * atmosphere.top_radius);
    // If the viewer is in space and the view ray intersects the atmosphere, move
    // the viewer to the top atmosphere boundary (along the view ray):
    if (distance_to_top_atmosphere_boundary > 0.0) {
        camera = camera + view_ray * distance_to_top_atmosphere_boundary;
        r = atmosphere.top_radius;
        rmu += distance_to_top_atmosphere_boundary;
    } else if (r > atmosphere.top_radius) {
        // If the view ray does not intersect the atmosphere, simply return 0.
        transmittance = vec3(1.0);
        // watt_per_square_meter_per_sr_per_nm
        return vec3(0.0);
    }
    // Compute the r, mu, mu_s and nu parameters needed for the texture lookups.
    float mu = rmu / r;
    float mu_s = dot(camera, sun_direction) / r;
    float nu = dot(view_ray, sun_direction);
    bool ray_r_mu_intersects_ground = RayIntersectsGround(atmosphere, r, mu);

    transmittance = ray_r_mu_intersects_ground ? vec3(0.0) :
        GetTransmittanceToTopAtmosphereBoundary(
            atmosphere, transmittance_texture, r, mu);
    vec3 single_mie_scattering;
    vec3 scattering;
    // if (shadow_length == 0.0 * m) {
    scattering = GetCombinedScattering(
        atmosphere, scattering_texture,
        r, mu, mu_s, nu, ray_r_mu_intersects_ground,
        single_mie_scattering);
    // } else {
    //     // Case of light shafts (shadow_length is the total length noted l in our
    //     // paper): we omit the scattering between the camera and the point at
    //     // distance l, by implementing Eq. (18) of the paper (shadow_transmittance
    //     // is the T(x,x_s) term, scattering is the S|x_s=x+lv term).
    //     Length d = shadow_length;
    //     Length r_p =
    //         ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
    //     Number mu_p = (r * mu + d) / r_p;
    //     Number mu_s_p = (r * mu_s + d * nu) / r_p;

    //     scattering = GetCombinedScattering(
    //         atmosphere, scattering_texture, single_mie_scattering_texture,
    //         r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground,
    //         single_mie_scattering);
    //     DimensionlessSpectrum shadow_transmittance =
    //         GetTransmittance(atmosphere, transmittance_texture,
    //                          r, mu, shadow_length, ray_r_mu_intersects_ground);
    //     scattering = scattering * shadow_transmittance;
    //     single_mie_scattering = single_mie_scattering * shadow_transmittance;
    // }
    return scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
        MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
}

vec3 GetSkyRadianceToPoint(
    AtmosphereParameters atmosphere,
    sampler2D transmittance_texture,
    sampler3D scattering_texture,
    vec3 camera, vec3 view_ray, vec3 point,
    vec3 sun_direction, out vec3 transmittance) {
    // Compute the distance to the top atmosphere boundary along the view ray,
    // assuming the viewer is in space (or NaN if the view ray does not intersect
    // the atmosphere).
    float r = length(camera);
    float rmu = dot(camera, view_ray);
    float distance_to_top_atmosphere_boundary = -rmu -
        sqrt(rmu * rmu - r * r + atmosphere.top_radius * atmosphere.top_radius);

    // If the viewer is in space and the view ray intersects the atmosphere, move
    // the viewer to the top atmosphere boundary (along the view ray):
    if (distance_to_top_atmosphere_boundary > 0.0) {
        camera = camera + view_ray * distance_to_top_atmosphere_boundary;
        r = atmosphere.top_radius;
        rmu += distance_to_top_atmosphere_boundary;
    } else if (r > atmosphere.top_radius) {
        // If the view ray does not intersect the atmosphere, simply return 0.
        transmittance = vec3(1.0);
        // watt_per_square_meter_per_sr_per_nm
        return vec3(0.0);
    }

    // Compute the r, mu, mu_s and nu parameters for the first texture lookup.
    float mu = rmu / r;
    float mu_s = dot(camera, sun_direction) / r;
    float nu = dot(view_ray, sun_direction);
    float d = length(point - camera);
    bool ray_r_mu_intersects_ground = RayIntersectsGround(atmosphere, r, mu);

    transmittance = GetTransmittance(atmosphere, transmittance_texture,
                                     r, mu, d, ray_r_mu_intersects_ground);

    vec3 single_mie_scattering;
    vec3 scattering = GetCombinedScattering(
        atmosphere, scattering_texture,
        r, mu, mu_s, nu, ray_r_mu_intersects_ground,
        single_mie_scattering);

    if (!isinf(d)) {
        // Compute the r, mu, mu_s and nu parameters for the second texture lookup.
        // If shadow_length is not 0 (case of light shafts), we want to ignore the
        // scattering along the last shadow_length meters of the view ray, which we
        // do by subtracting shadow_length from d (this way scattering_p is equal to
        // the S|x_s=x_0-lv term in Eq. (17) of our paper).
        // d = max(d - shadow_length, 0.0 * m);
        float r_p = ClampRadius(atmosphere, sqrt(d * d + 2.0 * r * mu * d + r * r));
        float mu_p = (r * mu + d) / r_p;
        float mu_s_p = (r * mu_s + d * nu) / r_p;

        vec3 single_mie_scattering_p;
        vec3 scattering_p = GetCombinedScattering(
                                                  atmosphere, scattering_texture,
                                                  r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground,
                                                  single_mie_scattering_p);

        // Combine the lookup results to get the scattering between camera and point.
        vec3 shadow_transmittance = transmittance;
        // if (shadow_length > 0.0 * m) {
        //   // This is the T(x,x_s) term in Eq. (17) of our paper, for light shafts.
        //   shadow_transmittance = GetTransmittance(atmosphere, transmittance_texture,
        //       r, mu, d, ray_r_mu_intersects_ground);
        // }
        scattering = scattering - shadow_transmittance * scattering_p;
        single_mie_scattering =
            single_mie_scattering - shadow_transmittance * single_mie_scattering_p;
        single_mie_scattering = GetExtrapolatedSingleMieScattering(
                                                                   atmosphere, vec4(scattering, single_mie_scattering.r));

        // Hack to avoid rendering artifacts when the sun is below the horizon.
        single_mie_scattering = single_mie_scattering *
            smoothstep(0.0, 0.01, mu_s);
    }

    return scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
        MiePhaseFunction(atmosphere.mie_phase_function_g, nu);
}


struct AtmosphereParametersUniform
{
    vec4 solar_irradiance;
    vec4 rayleigh_scattering;
    vec4 mie_scattering;
    vec4 mie_extinction;
    vec4 ground_albedo;
    vec4 absorption_extinction;

    float sun_angular_radius;
    float bottom_radius;
    float top_radius;
    float mie_phase_function_g;
    float mu_s_min;

    int transmittance_texture_mu_size;
    int transmittance_texture_r_size;
    int scattering_texture_r_size;
    int scattering_texture_mu_size;
    int scattering_texture_mu_s_size;
    int scattering_texture_nu_size;
    int irradiance_texture_mu_s_size;
    int irradiance_texture_r_size;

    float rayleigh_density_layer_0_width;
    float rayleigh_density_layer_0_exp_term;
    float rayleigh_density_layer_0_exp_scale;
    float rayleigh_density_layer_0_linear_term;
    float rayleigh_density_layer_0_constant_term;
    float rayleigh_density_layer_1_width;
    float rayleigh_density_layer_1_exp_term;
    float rayleigh_density_layer_1_exp_scale;
    float rayleigh_density_layer_1_linear_term;
    float rayleigh_density_layer_1_constant_term;

    float mie_density_layer_0_width;
    float mie_density_layer_0_exp_term;
    float mie_density_layer_0_exp_scale;
    float mie_density_layer_0_linear_term;
    float mie_density_layer_0_constant_term;
    float mie_density_layer_1_width;
    float mie_density_layer_1_exp_term;
    float mie_density_layer_1_exp_scale;
    float mie_density_layer_1_linear_term;
    float mie_density_layer_1_constant_term;

    float absorption_density_layer_0_width;
    float absorption_density_layer_0_exp_term;
    float absorption_density_layer_0_exp_scale;
    float absorption_density_layer_0_linear_term;
    float absorption_density_layer_0_constant_term;
    float absorption_density_layer_1_width;
    float absorption_density_layer_1_exp_term;
    float absorption_density_layer_1_exp_scale;
    float absorption_density_layer_1_linear_term;
    float absorption_density_layer_1_constant_term;
};

AtmosphereParameters GetAtmosphereParemeters(AtmosphereParametersUniform params)
{
    AtmosphereParameters atmosphere;

    atmosphere.solar_irradiance = params.solar_irradiance.rgb;
    atmosphere.rayleigh_scattering = params.rayleigh_scattering.rgb;
    atmosphere.mie_scattering = params.mie_scattering.rgb;
    atmosphere.mie_extinction = params.mie_extinction.rgb;
    atmosphere.ground_albedo = params.ground_albedo.rgb;
    atmosphere.absorption_extinction = params.absorption_extinction.rgb;
    atmosphere.sun_angular_radius = params.sun_angular_radius;
    atmosphere.bottom_radius = params.bottom_radius;
    atmosphere.top_radius = params.top_radius;
    atmosphere.mie_phase_function_g = params.mie_phase_function_g;
    atmosphere.mu_s_min = params.mu_s_min;
    atmosphere.transmittance_texture_mu_size = params.transmittance_texture_mu_size;
    atmosphere.transmittance_texture_r_size = params.transmittance_texture_r_size;
    atmosphere.scattering_texture_r_size = params.scattering_texture_r_size;
    atmosphere.scattering_texture_mu_size = params.scattering_texture_mu_size;
    atmosphere.scattering_texture_mu_s_size = params.scattering_texture_mu_s_size;
    atmosphere.scattering_texture_nu_size = params.scattering_texture_nu_size;
    atmosphere.irradiance_texture_mu_s_size = params.irradiance_texture_mu_s_size;
    atmosphere.irradiance_texture_r_size = params.irradiance_texture_r_size;

    atmosphere.rayleigh_density.layers[0].width = params.rayleigh_density_layer_0_width;
    atmosphere.rayleigh_density.layers[0].exp_term = params.rayleigh_density_layer_0_exp_term;
    atmosphere.rayleigh_density.layers[0].exp_scale = params.rayleigh_density_layer_0_exp_scale;
    atmosphere.rayleigh_density.layers[0].linear_term = params.rayleigh_density_layer_0_linear_term;
    atmosphere.rayleigh_density.layers[0].constant_term = params.rayleigh_density_layer_0_constant_term;
    atmosphere.rayleigh_density.layers[1].width = params.rayleigh_density_layer_1_width;
    atmosphere.rayleigh_density.layers[1].exp_term = params.rayleigh_density_layer_1_exp_term;
    atmosphere.rayleigh_density.layers[1].exp_scale = params.rayleigh_density_layer_1_exp_scale;
    atmosphere.rayleigh_density.layers[1].linear_term = params.rayleigh_density_layer_1_linear_term;
    atmosphere.rayleigh_density.layers[1].constant_term = params.rayleigh_density_layer_1_constant_term;

    atmosphere.mie_density.layers[0].width = params.mie_density_layer_0_width;
    atmosphere.mie_density.layers[0].exp_term = params.mie_density_layer_0_exp_term;
    atmosphere.mie_density.layers[0].exp_scale = params.mie_density_layer_0_exp_scale;
    atmosphere.mie_density.layers[0].linear_term = params.mie_density_layer_0_linear_term;
    atmosphere.mie_density.layers[0].constant_term = params.mie_density_layer_0_constant_term;
    atmosphere.mie_density.layers[1].width = params.mie_density_layer_1_width;
    atmosphere.mie_density.layers[1].exp_term = params.mie_density_layer_1_exp_term;
    atmosphere.mie_density.layers[1].exp_scale = params.mie_density_layer_1_exp_scale;
    atmosphere.mie_density.layers[1].linear_term = params.mie_density_layer_1_linear_term;
    atmosphere.mie_density.layers[1].constant_term = params.mie_density_layer_1_constant_term;

    atmosphere.absorption_density.layers[0].width = params.absorption_density_layer_0_width;
    atmosphere.absorption_density.layers[0].exp_term = params.absorption_density_layer_0_exp_term;
    atmosphere.absorption_density.layers[0].exp_scale = params.absorption_density_layer_0_exp_scale;
    atmosphere.absorption_density.layers[0].linear_term = params.absorption_density_layer_0_linear_term;
    atmosphere.absorption_density.layers[0].constant_term = params.absorption_density_layer_0_constant_term;
    atmosphere.absorption_density.layers[1].width = params.absorption_density_layer_1_width;
    atmosphere.absorption_density.layers[1].exp_term = params.absorption_density_layer_1_exp_term;
    atmosphere.absorption_density.layers[1].exp_scale = params.absorption_density_layer_1_exp_scale;
    atmosphere.absorption_density.layers[1].linear_term = params.absorption_density_layer_1_linear_term;
    atmosphere.absorption_density.layers[1].constant_term = params.absorption_density_layer_1_constant_term;

    return atmosphere;
}


layout (location = 0) in vec2 v_TexCoords;

layout (set = 0, binding = 0) uniform Params
{
    AtmosphereParametersUniform u_Params;
};
layout(set = 0, binding = 1) uniform sampler2D u_Transmittance;
layout(set = 0, binding = 2) uniform sampler2D u_Irradiance;
layout(set = 0, binding = 3) uniform sampler3D u_Scattering;

layout(push_constant) uniform PushConstant
{
    mat4 InverseViewProjection;
    vec3 CameraPosition;
    float Padding;
    vec3 SunDirection;
    float Exposure;
} pc;


layout (location = 0) out vec4 o_Color;


void main()
{   

    AtmosphereParameters atmosphere = GetAtmosphereParemeters(u_Params);

    vec3 view = normalize((pc.InverseViewProjection * vec4(2*v_TexCoords - 1, 0, 1)).xyz);

#if 0
    vec4 world_pre = (pc.InverseViewProjection * vec4(2*v_TexCoords - 1, 1, 1));
    vec3 world = (world_pre.xyz / world_pre.w) * 1e-3;
    vec3 transmittance;
    vec3 color = GetSkyRadianceToPoint(
        atmosphere, u_Transmittance, u_Scattering,
        pc.CameraPosition, view, world, pc.SunDirection,
        transmittance);

#endif
    const vec3 earth_center = vec3(0, -6360, 0);

    vec3 p = pc.CameraPosition - earth_center;
    float p_dot_v = dot(p, view);
    float p_dot_p = dot(p, p);
    float ray_earth_center_squared_distance = p_dot_p - p_dot_v * p_dot_v;
    float distance_to_intersection = -p_dot_v - sqrt(
      earth_center.y * earth_center.y - ray_earth_center_squared_distance);

    // Compute the radiance reflected by the ground, if the ray intersects it.
    float ground_alpha = 0.0;
    vec3 ground_radiance = vec3(0.0);
    if (distance_to_intersection > 0.0) 
    {
        vec3 point = pc.CameraPosition + view * distance_to_intersection;
        vec3 normal = normalize(point - earth_center);

        	// Compute the radiance reflected by the ground.
        vec3 sky_irradiance;
        vec3 sun_irradiance = GetSunAndSkyIrradiance(
            atmosphere, u_Transmittance, u_Irradiance, 
            point - earth_center, normal, pc.SunDirection, sky_irradiance);

        vec3 transmittance;
        vec3 in_scatter = GetSkyRadianceToPoint(
            atmosphere, u_Transmittance, u_Scattering, 
            pc.CameraPosition - earth_center, view, point - earth_center, pc.SunDirection, transmittance);

        ground_radiance = (atmosphere.ground_albedo / PI) * (sun_irradiance + sky_irradiance);
        ground_radiance = ground_radiance * transmittance + in_scatter;
        ground_alpha = 1.0;
    }

    vec3 transmittance;
    vec3 sky_radiance = GetSkyRadiance(
      atmosphere, u_Transmittance, u_Scattering, 
      pc.CameraPosition - earth_center, view, pc.SunDirection, 
      transmittance);
    
    vec3 color = mix(sky_radiance, ground_radiance, ground_alpha);

    //color = pow(1.0 - exp(-color * pc.Exposure), vec3(1.0 / 2.2));
    o_Color = vec4(color, 1.0);
}